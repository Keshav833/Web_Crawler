import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserFetcher } from "../src/browser-fetcher.js";
import { HttpError, USER_AGENT } from "../src/fetcher.js";

describe("BrowserFetcher lifecycle", () => {
    let browserFetcher: BrowserFetcher | undefined;
    let server: ReturnType<typeof createServer> | undefined;

    afterEach(async () => {
        await browserFetcher?.close();
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
    });

    it("initializes Chromium once for concurrent callers and closes safely", async () => {
        browserFetcher = new BrowserFetcher();

        await Promise.all([
            browserFetcher.initialize(),
            browserFetcher.initialize(),
            browserFetcher.initialize(),
        ]);

        await browserFetcher.close();
        await expect(browserFetcher.close()).resolves.toBeUndefined();
    }, 30000);

    it("returns rendered HTML from a local page and sends the crawler user-agent", async () => {
        server = createServer((request, response) => {
            expect(request.headers["user-agent"]).toContain(USER_AGENT);
            response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            response.end(
                "<html><body><script>document.body.innerHTML = '<main>Rendered</main>'</script></body></html>"
            );
        });
        const url = await listen(server);
        browserFetcher = new BrowserFetcher();

        const html = await browserFetcher.fetchPage(url);

        expect(html).toContain("<main>Rendered</main>");
    }, 30000);

    it("rejects unsuccessful HTTP responses and times out stalled navigation", async () => {
        server = createServer((request, response) => {
            if (request.url === "/missing") {
                response.writeHead(404, { "content-type": "text/html" });
                response.end("Not found");
                return;
            }

            if (request.url === "/slow") {
                setTimeout(() => {
                    if (!response.destroyed) {
                        response.writeHead(200, { "content-type": "text/html" });
                        response.end("<html>Late response</html>");
                    }
                }, 500);
                return;
            }

            response.writeHead(200, { "content-type": "text/html" });
            response.end("<html>Ready</html>");
        });
        const url = await listen(server);
        browserFetcher = new BrowserFetcher();

        await expect(browserFetcher.fetchPage(`${url}/missing`)).rejects.toBeInstanceOf(
            HttpError
        );
        await expect(
            browserFetcher.fetchPage(`${url}/slow`, {
                timeoutMs: 100,
                maxAttempts: 1,
            })
        ).rejects.toThrow(/timeout/i);
        await expect(browserFetcher.fetchPage(url)).resolves.toContain("Ready");
    }, 30000);

    it("skips non-HTML responses", async () => {
        server = createServer((_request, response) => {
            response.writeHead(200, { "content-type": "application/pdf" });
            response.end("%PDF");
        });
        const url = await listen(server);
        browserFetcher = new BrowserFetcher();

        await expect(browserFetcher.fetchPage(url)).resolves.toBeNull();
    }, 30000);

    it("retries a transient server error when attempts are configured", async () => {
        let attempts = 0;
        server = createServer((_request, response) => {
            attempts++;
            if (attempts === 1) {
                response.writeHead(503, { "content-type": "text/html" });
                response.end("Unavailable");
                return;
            }

            response.writeHead(200, { "content-type": "text/html" });
            response.end("<html>Recovered</html>");
        });
        const url = await listen(server);
        browserFetcher = new BrowserFetcher();

        await expect(
            browserFetcher.fetchPage(url, {
                maxAttempts: 2,
                requestDelayMs: 0,
            })
        ).resolves.toContain("Recovered");
        expect(attempts).toBe(2);
    }, 30000);
});

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
}
