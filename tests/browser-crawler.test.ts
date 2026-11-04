import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Crawler } from "../src/crawler.js";

describe("browser crawler integration", () => {
    let server: ReturnType<typeof createServer> | undefined;
    let testDir: string | undefined;

    afterEach(async () => {
        if (server?.listening) {
            await new Promise<void>((resolve, reject) => {
                server?.close((error) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            });
        }
        if (testDir) {
            await rm(testDir, { recursive: true, force: true });
        }
        vi.restoreAllMocks();
    });

    it("crawls JavaScript-discovered links through the normal crawler pipeline", async () => {
        const requestedPaths: string[] = [];
        server = createServer((request, response) => {
            const path = new URL(request.url ?? "/", "http://localhost").pathname;
            requestedPaths.push(path);

            if (path === "/robots.txt") {
                response.writeHead(200, { "content-type": "text/plain" });
                response.end("User-agent: *\nAllow: /");
                return;
            }

            response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            if (path === "/") {
                response.end(
                    "<!doctype html><html><head><title>Home</title></head><body><script>document.body.insertAdjacentHTML('beforeend', '<a href=\"/child\">Child</a>')</script></body></html>"
                );
                return;
            }

            response.end(
                "<!doctype html><html><head><title>Child</title></head><body>Child page</body></html>"
            );
        });
        const startUrl = await listen(server);
        testDir = await mkdtemp(join(tmpdir(), "browser-crawler-test-"));
        const crawler = new Crawler({
            startUrl,
            maxDepth: 1,
            concurrency: 2,
            requestDelayMs: 100,
            outputPath: join(testDir, "results.json"),
            mode: "browser",
            navigationTimeoutMs: 5000,
            fetchPageOptions: { requestDelayMs: 0 },
        });

        const result = await crawler.crawl();

        expect(result?.pages.map((page) => page.title).sort()).toEqual([
            "Child",
            "Home",
        ]);
        expect(requestedPaths).toContain("/robots.txt");
        expect(requestedPaths).toContain("/");
        expect(requestedPaths).toContain("/child");
        expect(result?.stats).toMatchObject({
            scrapedPages: 2,
            failedPages: 0,
            skippedPages: 0,
            activeWorkers: 0,
            outstandingTasks: 0,
        });
    }, 30000);
});

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}/`;
}
