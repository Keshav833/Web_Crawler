import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { createWebServer } from "../src/web-server.js";

describe("crawler dashboard UI", () => {
    let browser: Browser | undefined;
    let webServer: Server | undefined;
    let siteServer: Server | undefined;
    let testDirectory: string | undefined;

    afterEach(async () => {
        await browser?.close();
        await closeServer(webServer);
        await closeServer(siteServer);
        if (testDirectory) {
            await rm(testDirectory, { recursive: true, force: true });
        }
    });

    it("starts a crawl, displays page details, and downloads CSV", async () => {
        siteServer = createServer((request, response) => {
            if (request.url === "/robots.txt") {
                response.writeHead(404);
                response.end();
                return;
            }

            response.writeHead(200, { "content-type": "text/html" });
            response.end(
                "<html><head><title>UI fixture</title><meta name=\"description\" content=\"Rendered for the dashboard\"></head><body><h1>Useful details</h1><a href=\"/ignored\">Ignored at depth zero</a></body></html>"
            );
        });
        const startUrl = await listen(siteServer);
        testDirectory = await mkdtemp(join(tmpdir(), "crawler-dashboard-ui-"));
        webServer = createWebServer({
            outputPath: join(testDirectory, "results.json"),
        });
        const dashboardUrl = await listen(webServer);
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();

        await page.goto(dashboardUrl);
        await page.locator("#start-url").fill(startUrl);
        await page.locator("#max-depth").fill("0");
        await page.locator("#max-pages").fill("1");
        await page.locator("#concurrency").fill("1");
        await page.locator("#delay").fill("100");
        await page.locator("#start-button").click();

        await page.waitForFunction(
            () => document.querySelector("#state-label")?.textContent === "COMPLETED",
            undefined,
            { timeout: 15_000 }
        );
        expect(await page.locator(".page-title").textContent()).toBe("UI fixture");
        expect(await page.locator("#stat-scraped").textContent()).toBe("1");

        await page.locator(".data-row").click();
        expect(await page.locator("#detail-dialog").isVisible()).toBe(true);
        expect(await page.locator("#detail-description").textContent()).toBe(
            "Rendered for the dashboard"
        );
        expect(await page.locator("#detail-headings").innerText()).toContain(
            "Useful details"
        );

        await page.locator("#detail-dialog .dialog-close").click();
        const downloadPromise = page.waitForEvent("download");
        await page.locator("#download-csv").click();
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toBe("crawl-results.csv");
    }, 30_000);
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
