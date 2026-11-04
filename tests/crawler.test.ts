import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startUrl = "https://books.toscrape.com/";

function pageResponse(title: string, links = ""): Response {
    return new Response(
        `<html><head><title>${title}</title></head><body>${links}</body></html>`,
        {
            status: 200,
            headers: { "content-type": "text/html" },
        }
    );
}

async function loadFreshCrawler() {
    vi.resetModules();
    return import("../src/scraper.js");
}

beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("crawl worker pool", () => {
    it("keeps running when the queue is empty while a page can discover more work", async () => {
        const testDir = await mkdtemp(join(tmpdir(), "crawler-wakeup-test-"));
        const outputPath = join(testDir, "results.json");
        const pageRequests: string[] = [];

        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL) => {
                const url = new URL(String(input));
                if (url.pathname === "/robots.txt") {
                    return new Response("User-agent: *\nAllow: /", { status: 200 });
                }

                pageRequests.push(url.pathname);
                if (url.pathname === "/") {
                    return pageResponse("Home", '<a href="/child">child</a>');
                }
                if (url.pathname === "/child") {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                    return pageResponse(
                        "Child",
                        '<a href="/grandchild">grandchild</a>'
                    );
                }
                if (url.pathname === "/grandchild") {
                    return pageResponse("Grandchild");
                }

                throw new Error(`Unexpected page request: ${url.pathname}`);
            })
        );

        try {
            const { crawl } = await loadFreshCrawler();
            const stats = await crawl({
                fetchPageOptions: { requestDelayMs: 0 },
                outputPath,
            });
            const results = JSON.parse(await readFile(outputPath, "utf8")) as Array<{
                url: string;
            }>;

            expect(pageRequests).toEqual(["/", "/child", "/grandchild"]);
            expect(results).toHaveLength(3);
            expect(stats).toMatchObject({
                discoveredUrls: 3,
                queuedUrls: 3,
                scrapedPages: 3,
                failedPages: 0,
                skippedPages: 0,
                activeWorkers: 0,
                outstandingTasks: 0,
                exportPath: outputPath,
            });
            expect(stats?.crawlDurationMs).toBeGreaterThanOrEqual(0);
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it("deduplicates work, respects depth, caps concurrency, and reports outcomes", async () => {
        const testDir = await mkdtemp(join(tmpdir(), "crawler-stats-test-"));
        const outputPath = join(testDir, "results.json");
        const pageRequests: string[] = [];
        let activePages = 0;
        let maxActivePages = 0;

        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL) => {
                const url = new URL(String(input));
                if (url.pathname === "/robots.txt") {
                    return new Response(
                        "User-agent: MyCrawler/1.0\nDisallow: /blocked\n",
                        { status: 200 }
                    );
                }

                pageRequests.push(url.pathname);
                activePages++;
                maxActivePages = Math.max(maxActivePages, activePages);
                try {
                    if (url.pathname !== "/") {
                        await new Promise((resolve) => setTimeout(resolve, 20));
                    }

                    if (url.pathname === "/") {
                        return pageResponse(
                            "Home",
                            [
                                '<a href="/a">a</a>',
                                '<a href="/b">b</a>',
                                '<a href="/c">c</a>',
                                '<a href="/a?utm_source=duplicate">duplicate a</a>',
                                '<a href="/failure">failure</a>',
                                '<a href="/document">document</a>',
                                '<a href="/blocked">blocked</a>',
                                '<a href="https://outside.example/page">external</a>',
                            ].join("")
                        );
                    }
                    if (url.pathname === "/a" || url.pathname === "/b") {
                        return pageResponse(
                            url.pathname,
                            '<a href="/leaf">leaf</a>'
                        );
                    }
                    if (url.pathname === "/leaf") {
                        return pageResponse(
                            url.pathname,
                            '<a href="/too-deep">too deep</a>'
                        );
                    }
                    if (url.pathname === "/failure") {
                        return new Response("Unavailable", { status: 503 });
                    }
                    if (url.pathname === "/document") {
                        return new Response("not HTML", {
                            status: 200,
                            headers: { "content-type": "application/pdf" },
                        });
                    }
                    if (url.pathname === "/blocked") {
                        throw new Error("Robots-blocked URLs must not be fetched");
                    }

                    return pageResponse(url.pathname);
                } finally {
                    activePages--;
                }
            })
        );

        try {
            const { crawl } = await loadFreshCrawler();
            const stats = await crawl({
                fetchPageOptions: {
                    maxAttempts: 1,
                    requestDelayMs: 0,
                },
                outputPath,
            });
            const results = JSON.parse(await readFile(outputPath, "utf8")) as Array<{
                url: string;
            }>;

            expect(pageRequests).toHaveLength(7);
            expect(pageRequests.filter((path) => path === "/a")).toHaveLength(1);
            expect(pageRequests.filter((path) => path === "/leaf")).toHaveLength(1);
            expect(pageRequests).not.toContain("/blocked");
            expect(results).toHaveLength(5);
            expect(stats).toMatchObject({
                discoveredUrls: 10,
                queuedUrls: 8,
                scrapedPages: 5,
                failedPages: 1,
                skippedPages: 2,
                activeWorkers: 0,
                outstandingTasks: 0,
            });
            expect(stats?.maxObservedConcurrency).toBe(3);
            expect(maxActivePages).toBe(3);
            expect(maxActivePages).toBeLessThanOrEqual(3);
            expect(pageRequests).not.toContain("/too-deep");
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it("resets crawl state between sequential runs", async () => {
        const testDir = await mkdtemp(join(tmpdir(), "crawler-repeat-test-"));
        const outputPath = join(testDir, "results.json");
        const pageRequests: string[] = [];

        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL) => {
                const url = new URL(String(input));
                if (url.pathname === "/robots.txt") {
                    return new Response("User-agent: *\nAllow: /", { status: 200 });
                }

                pageRequests.push(url.pathname);
                return pageResponse("Home");
            })
        );

        try {
            const { crawl } = await loadFreshCrawler();
            const firstRun = await crawl({
                fetchPageOptions: { requestDelayMs: 0 },
                outputPath,
            });
            const secondRun = await crawl({
                fetchPageOptions: { requestDelayMs: 0 },
                outputPath,
            });

            expect(pageRequests).toEqual(["/", "/"]);
            expect(firstRun?.scrapedPages).toBe(1);
            expect(secondRun).toMatchObject({
                discoveredUrls: 1,
                queuedUrls: 1,
                scrapedPages: 1,
                failedPages: 0,
                skippedPages: 0,
                activeWorkers: 0,
                outstandingTasks: 0,
            });
            expect(secondRun?.crawlDurationMs).toBeGreaterThanOrEqual(0);
            expect(secondRun?.exportPath).toBe(outputPath);
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it("applies a custom start URL, depth, worker count, and page cap", async () => {
        const testDir = await mkdtemp(join(tmpdir(), "crawler-config-test-"));
        const outputPath = join(testDir, "results.json");
        const pageRequests: string[] = [];

        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL) => {
                const url = new URL(String(input));
                if (url.pathname === "/robots.txt") {
                    return new Response("User-agent: *\nAllow: /", { status: 200 });
                }

                pageRequests.push(url.href);
                return pageResponse(
                    "Custom start",
                    '<a href="/child">child</a>'
                );
            })
        );

        try {
            const { crawl } = await loadFreshCrawler();
            const stats = await crawl({
                startUrl: "https://custom.example/root",
                maxDepth: 2,
                concurrency: 1,
                maxPages: 1,
                fetchPageOptions: { requestDelayMs: 0 },
                outputPath,
            });

            expect(pageRequests).toEqual(["https://custom.example/root"]);
            expect(stats).toMatchObject({
                queuedUrls: 1,
                discoveredUrls: 2,
                scrapedPages: 1,
                maxObservedConcurrency: 1,
                outstandingTasks: 0,
            });
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it("logs periodic progress for longer crawls", async () => {
        const testDir = await mkdtemp(join(tmpdir(), "crawler-progress-test-"));
        const outputPath = join(testDir, "results.json");

        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL) => {
                const url = new URL(String(input));
                if (url.pathname === "/robots.txt") {
                    return new Response("User-agent: *\nAllow: /", { status: 200 });
                }

                if (url.pathname === "/") {
                    const links = Array.from(
                        { length: 9 },
                        (_, index) => `<a href="/page-${index}">page</a>`
                    ).join("");
                    return pageResponse("Home", links);
                }

                return pageResponse(url.pathname);
            })
        );

        try {
            const { crawl } = await loadFreshCrawler();
            await crawl({
                maxPages: 10,
                fetchPageOptions: { requestDelayMs: 0 },
                outputPath,
            });

            expect(console.log).toHaveBeenCalledWith(
                "Crawl progress:",
                expect.objectContaining({
                    completedPages: 10,
                    activeWorkers: 0,
                    outstandingTasks: 0,
                })
            );
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it("returns pages and stats from independent concurrent Crawler instances", async () => {
        const testDir = await mkdtemp(join(tmpdir(), "crawler-api-test-"));
        const firstOutput = join(testDir, "first.json");
        const secondOutput = join(testDir, "second.json");

        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL) => {
                const url = new URL(String(input));
                if (url.pathname === "/robots.txt") {
                    return new Response("User-agent: *\nAllow: /", { status: 200 });
                }

                return pageResponse(url.hostname);
            })
        );

        try {
            vi.resetModules();
            const { Crawler } = await import("../src/index.js");
            const firstCrawler = new Crawler({
                startUrl: "https://first.example/",
                maxDepth: 0,
                outputPath: firstOutput,
                fetchPageOptions: { requestDelayMs: 0 },
            });
            const secondCrawler = new Crawler({
                startUrl: "https://second.example/",
                maxDepth: 0,
                outputPath: secondOutput,
                fetchPageOptions: { requestDelayMs: 0 },
            });

            const [firstResult, secondResult] = await Promise.all([
                firstCrawler.crawl(),
                secondCrawler.crawl(),
            ]);
            const repeatedFirstResult = await firstCrawler.crawl();

            expect(firstResult?.pages.map((page) => page.url)).toEqual([
                "https://first.example/",
            ]);
            expect(secondResult?.pages.map((page) => page.url)).toEqual([
                "https://second.example/",
            ]);
            expect(firstResult?.stats.scrapedPages).toBe(1);
            expect(secondResult?.stats.scrapedPages).toBe(1);
            expect(repeatedFirstResult?.stats).toMatchObject({
                queuedUrls: 1,
                scrapedPages: 1,
                outstandingTasks: 0,
            });
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });
});
