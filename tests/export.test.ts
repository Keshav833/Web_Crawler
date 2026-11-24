import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { crawl } from "../src/index.js";
import type { RequestInfo } from "node:fetch";

async function loadFreshCrawler() {
    // Clear module cache to reload fresh
    return { crawl };
}

describe("export", () => {
    afterEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    it("writes valid structured page results to the configured path", async () => {
        const testDir = await mkdtemp(join(tmpdir(), "crawler-integration-test-"));
        const outputPath = join(testDir, "crawl-results.json");

        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL) => {
                const url = new URL(String(input));
                if (url.pathname === "/robots.txt") {
                    return new Response("", { status: 404 });
                }

                if (url.pathname === "/" || url.pathname === "/book") {
                    return new Response(
                        `
            <html>
              <head>
                <title>Catalog</title>
                <meta name="description" content="Book catalog">
              </head>
              <body>
                <h1>Books</h1>
                <h2>Featured</h2>
                <a href="/book">Link</a>
              </body>
            </html>
            `,
                        { status: 200, headers: { "content-type": "text/html" } }
                    );
                }

                return new Response("Not found", { status: 404 });
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
            expect(results).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        url: "https://books.toscrape.com/",
                        title: "Catalog",
                        description: "Book catalog",
                        headings: ["Books", "Featured"],
                        linksCount: 1,
                    }),
                    expect.objectContaining({
                        url: "https://books.toscrape.com/book",
                        title: "Catalog",
                        description: "Book catalog",
                        headings: ["Books", "Featured"],
                        linksCount: 1,
                    }),
                ])
            );
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
                    return new Response("", { status: 404 });
                }

                if (url.pathname === "/") {
                    return new Response(
                        `
            <html>
              <head>
                <title>Catalog</title>
                <meta name="description" content="Book catalog">
              </head>
              <body>
                <h1>Books</h1>
                <h2>Featured</h2>
                <a href="/link">Link</a>
              </body>
            </html>
            `,
                        { status: 200, headers: { "content-type": "text/html" } }
                    );
                }

                return new Response("Not found", { status: 404 });
            })
        );

        try {
            const { crawl } = await loadFreshCrawler();
            await crawl({
                fetchPageOptions: { requestDelayMs: 0 },
                outputPath,
                format: "csv",
            });

            const content = await readFile(outputPath, "utf8");
            const lines = content.split("\r\n");

            expect(lines[0]).toBe("url,title,description,headings,linksCount");
            expect(lines[1]).toContain("https://books.toscrape.com/");
        } finally {
            await rm(testDir, { recursive: true, force: true });
        }
    });
});
