import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function loadFreshCrawler() {
    vi.resetModules();
    return import("../src/scraper.js");
}

beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("JSON export", () => {
    it("writes valid structured page results to the configured path", async () => {
        const testDir = await mkdtemp(join(tmpdir(), "crawler-export-test-"));
        const outputPath = join(testDir, "crawl-results.json");

        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL) => {
                const url = new URL(String(input));
                if (url.pathname === "/robots.txt") {
                    return new Response("User-agent: *\nAllow: /", { status: 200 });
                }

                return new Response(
                    [
                        "<html><head>",
                        "<title>Catalog</title>",
                        '<meta name="description" content="Book catalog">',
                        "</head><body>",
                        "<h1>Books</h1><h2>Featured</h2>",
                        '<a href="/book">book</a>',
                        "</body></html>",
                    ].join(""),
                    {
                        status: 200,
                        headers: { "content-type": "text/html" },
                    }
                );
            })
        );

        try {
            const { crawl } = await loadFreshCrawler();
            await crawl({
                fetchPageOptions: { requestDelayMs: 0 },
                outputPath,
            });

            const content = await readFile(outputPath, "utf8");
            const results: unknown = JSON.parse(content);

            expect(Array.isArray(results)).toBe(true);
            expect(results).toEqual([
                {
                    url: "https://books.toscrape.com/",
                    title: "Catalog",
                    description: "Book catalog",
                    headings: ["Books", "Featured"],
                    linksCount: 1,
                },
                {
                    url: "https://books.toscrape.com/book",
                    title: "Catalog",
                    description: "Book catalog",
                    headings: ["Books", "Featured"],
                    linksCount: 1,
                },
            ]);
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it("writes a valid empty array when no page is scraped", async () => {
        const testDir = await mkdtemp(join(tmpdir(), "crawler-empty-export-test-"));
        const outputPath = join(testDir, "empty-results.json");
        const pageRequests: string[] = [];

        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL) => {
                const url = new URL(String(input));
                if (url.pathname === "/robots.txt") {
                    return new Response(
                        "User-agent: *\nDisallow: /\n",
                        { status: 200 }
                    );
                }

                pageRequests.push(url.pathname);
                throw new Error("Robots-blocked URLs must not be fetched");
            })
        );

        try {
            const { crawl } = await loadFreshCrawler();
            const stats = await crawl({ outputPath });
            const content = await readFile(outputPath, "utf8");

            expect(JSON.parse(content)).toEqual([]);
            expect(pageRequests).toEqual([]);
            expect(stats).toMatchObject({
                scrapedPages: 0,
                skippedPages: 1,
                activeWorkers: 0,
                outstandingTasks: 0,
            });
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it("writes a CSV crawl result to the configured path", async () => {
        const testDir = await mkdtemp(join(tmpdir(), "crawler-csv-integration-test-"));
        const outputPath = join(testDir, "crawl-results.csv");

        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL) => {
                const url = new URL(String(input));
                if (url.pathname === "/robots.txt") {
                    return new Response("User-agent: *\nAllow: /", { status: 200 });
                }

                return new Response(
                    "<html><head><title>Catalog, Books</title></head><body><h1>Books</h1></body></html>",
                    {
                        status: 200,
                        headers: { "content-type": "text/html" },
                    }
                );
            })
        );

        try {
            const { crawl } = await loadFreshCrawler();
            await crawl({
                format: "csv",
                maxDepth: 0,
                fetchPageOptions: { requestDelayMs: 0 },
                outputPath,
            });

            const content = await readFile(outputPath, "utf8");
            expect(content).toBe(
                [
                    "url,title,description,headings,linksCount",
                    'https://books.toscrape.com/,"Catalog, Books",,"[""Books""]",0',
                    "",
                ].join("\r\n")
            );
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });
});
