import type { Browser, Response as BrowserResponse } from "playwright";
import {
    HttpError,
    resolveFetchPageOptions,
    USER_AGENT,
    waitForRequestSlot,
    type FetchPageOptions,
} from "./fetcher.js";

export type BrowserFetchPageOptions = FetchPageOptions;

function mediaType(response: BrowserResponse | null | undefined): string | undefined {
    return response?.headers()["content-type"]?.split(";")[0]?.trim().toLowerCase();
}

function isHtmlMediaType(value: string | undefined): boolean {
    return value === "text/html" || value === "application/xhtml+xml";
}

function logUnsupportedContentType(url: string, value: string | undefined): void {
    console.log(
        `Skipping ${url}: unsupported Content-Type ${value ?? "(missing)"}`
    );
}

export class BrowserFetcher {
    private browser: Browser | undefined;
    private launchPromise: Promise<Browser> | undefined;

    async initialize(): Promise<void> {
        await this.getBrowser();
    }

    async close(): Promise<void> {
        const browser = this.browser;
        this.browser = undefined;

        if (browser?.isConnected()) {
            await browser.close();
        }
    }

    async fetchPage(
        url: string,
        options: BrowserFetchPageOptions = {}
    ): Promise<string | null> {
        const { maxAttempts, timeoutMs, requestDelayMs } =
            resolveFetchPageOptions(options);

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await this.navigate(url, timeoutMs, requestDelayMs);
            } catch (error) {
                const isTimeout =
                    error instanceof Error && error.name === "TimeoutError";
                const isHttpError = error instanceof HttpError;
                const isNetworkError =
                    error instanceof TypeError ||
                    (error instanceof Error && /net::ERR_[A-Z_]+/.test(error.message));
                const retryableHttpError =
                    isHttpError && (error.status === 429 || error.status >= 500);
                const shouldRetry =
                    isTimeout || isNetworkError || retryableHttpError;
                const willRetry = shouldRetry && attempt < maxAttempts;
                const failureType = isTimeout
                    ? "Timeout"
                    : isHttpError
                      ? `HTTP ${error.status}`
                      : isNetworkError
                        ? "Network"
                        : "Browser";
                const errorMessage =
                    error instanceof Error ? error.message : String(error);

                console.error(
                    `${failureType} failure for ${url} on attempt ${attempt}: ${errorMessage}${willRetry ? "; retrying" : ""}`
                );

                if (!willRetry) {
                    throw error;
                }
            }
        }

        throw new Error("Unexpected browser fetch failure");
    }

    private async navigate(
        url: string,
        timeoutMs: number,
        requestDelayMs: number
    ): Promise<string | null> {
        const browser = await this.getBrowser();
        const context = await browser.newContext({ userAgent: USER_AGENT });

        try {
            const page = await context.newPage();
            const mainFrameNavigation: { response: BrowserResponse | null } = {
                response: null,
            };
            page.on("response", (response) => {
                if (
                    response.request().isNavigationRequest() &&
                    response.frame() === page.mainFrame()
                ) {
                    mainFrameNavigation.response = response;
                }
            });
            let response: BrowserResponse | null;
            try {
                await waitForRequestSlot(requestDelayMs);
                response = await page.goto(url, {
                    waitUntil: "domcontentloaded",
                    timeout: timeoutMs,
                });
            } catch (error) {
                const failedNavigationResponse = mainFrameNavigation.response;
                if (failedNavigationResponse && !failedNavigationResponse.ok()) {
                    throw new HttpError(failedNavigationResponse.status());
                }
                const contentType = mediaType(failedNavigationResponse);
                if (failedNavigationResponse && !isHtmlMediaType(contentType)) {
                    logUnsupportedContentType(url, contentType);
                    return null;
                }
                throw error;
            }

            if (response && !response.ok()) {
                throw new HttpError(response.status());
            }

            const contentType = mediaType(response);
            if (!isHtmlMediaType(contentType)) {
                logUnsupportedContentType(url, contentType);
                return null;
            }

            return await page.content();
        } finally {
            await context.close();
        }
    }

    private async getBrowser(): Promise<Browser> {
        if (this.browser?.isConnected()) {
            return this.browser;
        }

        const launchPromise = this.launchPromise ?? this.launchBrowser();
        this.launchPromise = launchPromise;

        try {
            return await launchPromise;
        } finally {
            if (this.launchPromise === launchPromise) {
                this.launchPromise = undefined;
            }
        }
    }

    private async launchBrowser(): Promise<Browser> {
        try {
            const { chromium } = await import("playwright");
            const browser = await chromium.launch({ headless: true });
            this.browser = browser;
            return browser;
        } catch (error) {
            if (
                error instanceof Error &&
                "code" in error &&
                error.code === "ERR_MODULE_NOT_FOUND"
            ) {
                throw new Error(
                    "Browser mode requires the optional Playwright package. Install dependencies with `npm install`.",
                    { cause: error }
                );
            }

            if (
                error instanceof Error &&
                error.message.includes("Executable doesn't exist")
            ) {
                throw new Error(
                    "Playwright Chromium is not installed. Run `npx playwright install chromium`.",
                    { cause: error }
                );
            }

            throw error;
        }
    }
}
