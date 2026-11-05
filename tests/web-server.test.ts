import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWebServer } from "../src/web-server.js";

describe("local crawler dashboard server", () => {
    let webServer: Server | undefined;
    let siteServer: Server | undefined;
    let testDirectory: string | undefined;

    afterEach(async () => {
        await closeServer(webServer);
        await closeServer(siteServer);
        if (testDirectory) {
            await rm(testDirectory, { recursive: true, force: true });
        }
    });

    it("serves dashboard assets and rejects non-local or cross-origin requests", async () => {
        webServer = createWebServer();
        const baseUrl = await listen(webServer);

        const page = await fetch(baseUrl);
        expect(page.status).toBe(200);
        expect(page.headers.get("content-type")).toContain("text/html");
        expect(await page.text()).toContain("Start crawling");

        const script = await fetch(`${baseUrl}/app.js`);
        expect(script.status).toBe(200);
        expect(await script.text()).toContain("/api/status");

        const denied = await fetch(`${baseUrl}/api/status`, {
            headers: { origin: "http://attacker.example" },
        });
        expect(denied.status).toBe(403);

        const invalidHost = await requestWithHost(`${baseUrl}/api/status`, "attacker.example");
        expect(invalidHost).toBe(403);
    });

    it("rejects invalid crawl configuration without starting a job", async () => {
        webServer = createWebServer();
        const baseUrl = await listen(webServer);

        const response = await fetch(`${baseUrl}/api/crawl`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                startUrl: "https://example.com/",
                concurrency: 11,
            }),
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
            error: "--concurrency must be between 1 and 10",
        });
        const status = await fetch(`${baseUrl}/api/status`);
        expect(await status.json()).toMatchObject({ state: "idle" });
    });

    it("protects public crawl requests and enforces the configured hostname allowlist", async () => {
        webServer = createWebServer({
            publicMode: {
                publicOrigin: "https://crawler.example.com",
                crawlPassword: "test-password-with-at-least-20-chars",
                allowedHosts: ["books.toscrape.com"],
            },
        });
        const baseUrl = await listen(webServer);
        const publicHeaders = {
            host: "crawler.example.com",
            "x-forwarded-proto": "https",
            origin: "https://crawler.example.com",
            "x-forwarded-for": "203.0.113.44",
        };

        const config = await requestJson(baseUrl, "/api/config", {
            method: "GET",
            headers: publicHeaders,
        });
        expect(config.status).toBe(200);
        expect(config.body).toMatchObject({
            crawlPasswordRequired: true,
            browserModeAvailable: false,
            crawlHosts: ["books.toscrape.com"],
        });

        const crossOrigin = await requestJson(baseUrl, "/api/config", {
            method: "GET",
            headers: {
                ...publicHeaders,
                origin: "https://attacker.example",
            },
        });
        expect(crossOrigin.status).toBe(403);

        const missingTlsProxyHeader = await requestJson(baseUrl, "/api/config", {
            method: "GET",
            headers: {
                host: "crawler.example.com",
                origin: "https://crawler.example.com",
            },
        });
        expect(missingTlsProxyHeader.status).toBe(403);

        const unauthorized = await requestJson(baseUrl, "/api/crawl", {
            method: "POST",
            headers: {
                ...publicHeaders,
                "content-type": "application/json",
            },
            body: JSON.stringify({ startUrl: "https://example.com/" }),
        });
        expect(unauthorized.status).toBe(401);

        const disallowedHost = await requestJson(baseUrl, "/api/crawl", {
            method: "POST",
            headers: {
                ...publicHeaders,
                "content-type": "application/json",
                "x-dashboard-password": "test-password-with-at-least-20-chars",
            },
            body: JSON.stringify({ startUrl: "https://example.com/" }),
        });
        expect(disallowedHost.status).toBe(400);
        expect(disallowedHost.body).toMatchObject({
            error: expect.stringContaining("crawl allowlist"),
        });

        const browserMode = await requestJson(baseUrl, "/api/crawl", {
            method: "POST",
            headers: {
                ...publicHeaders,
                "content-type": "application/json",
                "x-dashboard-password": "test-password-with-at-least-20-chars",
            },
            body: JSON.stringify({
                startUrl: "https://books.toscrape.com/",
                maxDepth: 3,
                maxPages: 100,
                concurrency: 2,
                requestDelayMs: 1000,
                mode: "browser",
            }),
        });
        expect(browserMode.status).toBe(400);
        expect(browserMode.body).toMatchObject({
            error: "Browser mode is disabled for public crawls",
        });
    });

    it("rate-limits repeated public crawl password failures", async () => {
        webServer = createWebServer({
            publicMode: {
                publicOrigin: "https://crawler.example.com",
                crawlPassword: "test-password-with-at-least-20-chars",
                allowedHosts: ["books.toscrape.com"],
            },
        });
        const baseUrl = await listen(webServer);
        const headers = {
            host: "crawler.example.com",
            "x-forwarded-proto": "https",
            origin: "https://crawler.example.com",
            "x-forwarded-for": "203.0.113.44",
            "content-type": "application/json",
            "x-dashboard-password": "incorrect",
        };
        let lastResponse = 0;
        for (let attempt = 0; attempt < 10; attempt++) {
            const response = await requestJson(baseUrl, "/api/crawl", {
                method: "POST",
                headers,
                body: JSON.stringify({ startUrl: "https://example.com/" }),
            });
            lastResponse = response.status;
        }
        expect(lastResponse).toBe(429);
    });

    it("rejects insecure public deployment settings", () => {
        expect(() =>
            createWebServer({
                publicMode: {
                    publicOrigin: "http://crawler.example.com",
                    crawlPassword: "test-password-with-at-least-20-chars",
                    allowedHosts: ["books.toscrape.com"],
                },
            })
        ).toThrow("PUBLIC_ORIGIN must be an HTTPS origin");
    });

    it("runs a crawl and serves results and downloadable JSON and CSV", async () => {
        testDirectory = await mkdtemp(join(tmpdir(), "crawler-dashboard-test-"));
        const requestedPaths: string[] = [];
        siteServer = createServer((request, response) => {
            const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
            requestedPaths.push(pathname);

            if (pathname === "/robots.txt") {
                response.writeHead(404);
                response.end();
                return;
            }

            response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            response.end(
                "<!doctype html><html><head><title>Local test page</title><meta name=\"description\" content=\"A local fixture\"></head><body><h1>Dashboard test</h1><a href=\"/child\">Child</a></body></html>"
            );
        });
        const startUrl = await listen(siteServer);
        webServer = createWebServer({
            outputPath: join(testDirectory, "results.json"),
        });
        const baseUrl = await listen(webServer);

        const started = await fetch(`${baseUrl}/api/crawl`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                startUrl,
                maxDepth: 0,
                concurrency: 1,
                requestDelayMs: 100,
                maxPages: 1,
                mode: "http",
            }),
        });
        expect(started.status).toBe(202);

        const conflictingStart = await fetch(`${baseUrl}/api/crawl`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ startUrl }),
        });
        expect(conflictingStart.status).toBe(409);

        const status = await waitForCompletion(baseUrl);
        expect(status).toMatchObject({
            state: "completed",
            stats: {
                scrapedPages: 1,
                failedPages: 0,
                skippedPages: 0,
                outstandingTasks: 0,
            },
        });
        expect(requestedPaths).toContain("/robots.txt");
        expect(requestedPaths).toContain("/");
        expect(requestedPaths).not.toContain("/child");

        const resultsResponse = await fetch(`${baseUrl}/api/results`);
        const pages = await resultsResponse.json();
        expect(pages).toEqual([
            {
                url: startUrl,
                title: "Local test page",
                description: "A local fixture",
                headings: ["Dashboard test"],
                linksCount: 1,
            },
        ]);

        const jsonDownload = await fetch(
            `${baseUrl}/api/download?format=json`
        );
        expect(jsonDownload.headers.get("content-disposition")).toContain(
            "crawl-results.json"
        );
        expect(await jsonDownload.json()).toEqual(pages);

        const csvDownload = await fetch(`${baseUrl}/api/download?format=csv`);
        expect(csvDownload.headers.get("content-type")).toContain("text/csv");
        expect(csvDownload.headers.get("content-disposition")).toContain(
            "crawl-results.csv"
        );
        expect(await csvDownload.text()).toContain(
            "url,title,description,headings,linksCount"
        );

        const savedResults = JSON.parse(
            await readFile(join(testDirectory, "results.json"), "utf8")
        ) as unknown;
        expect(savedResults).toEqual(pages);
    });
});

async function listen(server: Server): Promise<string> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server | undefined): Promise<void> {
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) => {
        server.close((error) => {
            if (error) reject(error);
            else resolve();
        });
    });
}

async function requestWithHost(url: string, host: string): Promise<number> {
    const parsedUrl = new URL(url);
    return new Promise((resolve, reject) => {
        const request = httpRequest(
            {
                hostname: "127.0.0.1",
                port: Number(parsedUrl.port),
                path: parsedUrl.pathname,
                headers: { host },
            },
            (response) => {
                response.resume();
                response.once("end", () => resolve(response.statusCode ?? 0));
            }
        );
        request.once("error", reject);
        request.end();
    });
}

async function requestJson(
    url: string,
    path: string,
    options: {
        method: string;
        headers: Record<string, string>;
        body?: string;
    }
): Promise<{ status: number; body: Record<string, unknown> }> {
    const parsedUrl = new URL(url);
    return new Promise((resolve, reject) => {
        const request = httpRequest(
            {
                hostname: "127.0.0.1",
                port: Number(parsedUrl.port),
                path,
                method: options.method,
                headers: options.headers,
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.once("end", () => {
                    resolve({
                        status: response.statusCode ?? 0,
                        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
                    });
                });
            }
        );
        request.once("error", reject);
        if (options.body) request.write(options.body);
        request.end();
    });
}

async function waitForCompletion(baseUrl: string): Promise<{
    state: string;
    stats: Record<string, number> | null;
}> {
    for (let attempt = 0; attempt < 100; attempt++) {
        const response = await fetch(`${baseUrl}/api/status`);
        const status = await response.json() as {
            state: string;
            stats: Record<string, number> | null;
        };
        if (status.state !== "running") return status;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }

    throw new Error("Dashboard crawl did not finish in time");
}
