import * as cheerio from "cheerio";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";

type RobotsParser = typeof import("robots-parser").default;

const robotsParser: RobotsParser =
    createRequire(import.meta.url)("robots-parser");


let robots: ReturnType<RobotsParser> | null = null ;

let activeWorkers = 0;


const MAX_DEPTH = 2;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT = 5000;
const REQUEST_DELAY = 1000;
let lastRequestTime = 0;
const CONCURRENCY = 3; // Fixed number of URL-processing workers.
const UNSUPPORTED_EXTENSIONS = new Set([
    "xml", "rss", "json", "pdf",
    "jpg", "jpeg", "png", "gif", "webp", "svg", "ico", "bmp", "avif",
    "mp3", "mp4", "wav", "avi", "mov", "webm",
    "css", "js", "mjs",
    "woff", "woff2", "ttf", "otf", "eot",
    "zip", "rar", "7z", "gz", "tar",
    "doc", "docx", "xls", "xlsx", "ppt", "pptx",
]);
const startUrl = "https://books.toscrape.com/";
const startDomain = new URL(startUrl).hostname;
const USER_AGENT = "MyCrawler/1.0";
const visited = new Set<string>();
const queued = new Set<string>([startUrl]);
const results: PageResult[] = [];

type QueueItem = {
    url: string;
    depth: number;
};

const queue: QueueItem[] = [
    {
        url: startUrl,
        depth: 0,
    },
];
const crawlStats = {
    discoveredUrls: 1,
    queuedUrls: 1,
    scrapedPages: 0,
    failedPages: 0,
    skippedPages: 0,
    maxObservedConcurrency: 0,
};
let outstandingTasks = queue.length;
const waitingWorkers = new Set<() => void>();

function notifyWaitingWorkers(): void {
    const waiters = [...waitingWorkers];
    waitingWorkers.clear();
    for (const wake of waiters) {
        wake();
    }
}

function waitForQueueChange(): Promise<void> {
    return new Promise((resolve) => {
        waitingWorkers.add(resolve);
    });
}

function enqueueUrl(item: QueueItem): void {
    if (visited.has(item.url) || queued.has(item.url)) {
        return;
    }

    queued.add(item.url);
    queue.push(item);
    crawlStats.queuedUrls++;
    outstandingTasks++;
    notifyWaitingWorkers();
}

//defines the data we want to collect from each page
type PageResult = {
    url: string;
    title: string;
    description: string;
    headings: string[];
    linksCount: number;
};

type ProcessOutcome = "scraped" | "skipped" | "failed";

// Processes one URL and returns its outcome.
async function processUrl(
    item: QueueItem,
    id: number
): Promise<ProcessOutcome> {
    const { url, depth } = item;

    if (visited.has(url)) {
        return "skipped";
    }

    visited.add(url);

    activeWorkers++;
    crawlStats.maxObservedConcurrency = Math.max(
        crawlStats.maxObservedConcurrency,
        activeWorkers
    );

    try {
        console.log(
            `Worker ${id} processing: ${url} | Active: ${activeWorkers}`
        );

        if (robots && !robots.isAllowed(url, USER_AGENT)) {
            console.log(`Blocked by robots.txt: ${url}`);
            return "skipped";
        }

        const html = await fetchPage(url);
        if (html === null) {
            return "skipped";
        }

        const $ = cheerio.load(html);

        const title = $("title").text().trim();
        const description =
            $('meta[name="description"]').attr("content")?.trim() ?? "";

        const headings = $("h1, h2, h3")
            .map((_, element) => $(element).text().trim())
            .get()
            .filter(Boolean);

        const linksCount = $("a[href]").length;

        if (depth < MAX_DEPTH) {
            $("a").each((_, element) => {
                const href = $(element).attr("href");
                if (!href) return;

                const normalizedUrl = normalizeUrl(href, url);
                if (!normalizedUrl) return;

                if (new URL(normalizedUrl).hostname !== startDomain) {
                    return;
                }

                crawlStats.discoveredUrls++;
                enqueueUrl({
                    url: normalizedUrl,
                    depth: depth + 1,
                });
            });
        }

        results.push({
            url,
            title,
            description,
            headings,
            linksCount,
        });

        console.log(`Scraped: ${title}`);
        return "scraped";
    } catch (error) {
        console.log(`Worker ${id} failed: ${url}`, error);
        return "failed";
    } finally {
        activeWorkers--;
    }
}

async function worker(id: number): Promise<void> {
    while (true) {
        const item = queue.shift();

        if (!item) {
            if (outstandingTasks === 0) {
                return;
            }

            await waitForQueueChange();
            continue;
        }

        let outcome: ProcessOutcome = "failed";
        try {
            outcome = await processUrl(item, id);
        } catch (error) {
            console.error(`Worker ${id} encountered an unexpected error`, error);
        } finally {
            outstandingTasks--;
            notifyWaitingWorkers();
        }

        switch (outcome) {
            case "scraped":
                crawlStats.scrapedPages++;
                break;
            case "skipped":
                crawlStats.skippedPages++;
                break;
            case "failed":
                crawlStats.failedPages++;
                break;
        }

        console.log("Crawl progress:", {
            ...crawlStats,
            activeWorkers,
        });
    }
}

// control how frequently our crawler sends requests.
function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

let rateLimitQueue: Promise<void> = Promise.resolve();

async function waitForRateLimit(): Promise<void> {
    let release!: () => void;

    const previous = rateLimitQueue;

    rateLimitQueue = new Promise<void>((resolve) => {
        release = resolve;
    });

    await previous;

    try {
        const now = Date.now();
        const elapsed = now - lastRequestTime;

        if (elapsed < REQUEST_DELAY) {
            await delay(REQUEST_DELAY - elapsed);
        }

        lastRequestTime = Date.now();
    } finally {
        release();
    }
}

class HttpError extends Error {
    constructor(readonly status: number) {
        super(`HTTP ${status}`);
        this.name = "HttpError";
    }
}

async function fetchPage(url: string): Promise<string | null> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const controller = new AbortController();

        const timeout = setTimeout(() => {
            controller.abort();
        }, REQUEST_TIMEOUT);

        try {
            await waitForRateLimit();

            console.log(`Fetching ${url} (attempt ${attempt})`);

            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    "user-agent": USER_AGENT,
                },
            });

            if (!response.ok) {
                throw new HttpError(response.status);
            }

            const contentType = response.headers.get("content-type");
            const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();

            if (mediaType !== "text/html" && mediaType !== "application/xhtml+xml") {
                console.log(
                    `Skipping ${url}: unsupported Content-Type ${contentType ?? "(missing)"}`
                );
                return null;
            }

            return await response.text();

        } catch (error) {
            const isTimeout = controller.signal.aborted;
            const isHttpError = error instanceof HttpError;
            const isNetworkError = error instanceof TypeError;
            const retryableHttpError =
                isHttpError && (error.status === 429 || error.status >= 500);
            const shouldRetry =
                isTimeout || isNetworkError || retryableHttpError;
            const failureType = isTimeout
                ? "Timeout"
                : isHttpError
                  ? `HTTP ${error.status}`
                  : isNetworkError
                    ? "Network"
                    : "Request";
            const willRetry = shouldRetry && attempt < MAX_ATTEMPTS;
            const errorMessage =
                error instanceof Error ? error.message : String(error);

            console.log(
                `${failureType} failure for ${url} on attempt ${attempt}: ${errorMessage}${willRetry ? "; retrying" : ""}`
            );

            if (!willRetry) {
                throw error;
            }

        } finally {
            clearTimeout(timeout);
        }
    }

    throw new Error("Unexpected fetch failure");
}

async function getRobotsParser(startUrl: string) {
    const origin = new URL(startUrl).origin;

    const robotsUrl = `${origin}/robots.txt`;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
        controller.abort();
    }, REQUEST_TIMEOUT);

    try {
        const response = await fetch(robotsUrl, {
            signal: controller.signal,
            headers: {
                "user-agent": USER_AGENT,
            },
        });

        if (response.status === 404) {
            console.log("robots.txt returned 404; proceeding without robots rules");
            return null;
        }

        if (!response.ok) {
            throw new HttpError(response.status);
        }

        const robotsText = await response.text();

        return robotsParser(robotsUrl, robotsText);
    } catch (error) {
        if (controller.signal.aborted) {
            throw new Error(`Timed out while fetching robots.txt after ${REQUEST_TIMEOUT}ms`);
        }
        if (error instanceof HttpError) {
            throw error;
        }
        if (error instanceof TypeError) {
            throw new Error(`Network error fetching robots.txt: ${error.message}`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

function normalizeUrl(rawUrl: string, baseUrl: string): string | null {
    try {
        const url = new URL(rawUrl, baseUrl);

        // Only allow HTTP and HTTPS
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return null;
        }

        const extension = url.pathname.match(/\.([^.\/]+)$/)?.[1]?.toLowerCase();
        if (extension && UNSUPPORTED_EXTENSIONS.has(extension)) {
            return null;
        }

        // Remove fragment
        url.hash = "";

        // Remove common tracking parameters
        const trackingParams = [
            "utm_source",
            "utm_medium",
            "utm_campaign",
            "utm_term",
            "utm_content",
            "fbclid",
            "gclid",
        ];

        for (const param of trackingParams) {
            url.searchParams.delete(param);
        }

        return url.href;
    } catch {
        return null;
    }
}

async function crawl() {
  try {
    robots = await getRobotsParser(startUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Crawling stopped; refusing to fetch pages because robots.txt could not be checked: ${message}`
    );
    return;
  }

  await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, index) => worker(index + 1))
  );

  await writeFile(
    "results.json",
    JSON.stringify(results, null, 2),
    "utf-8"
  );

  console.log("Crawling finished.");
  console.log("Crawl statistics:", {
    ...crawlStats,
    activeWorkers,
  });
  console.log("Results saved to results.json");
}

crawl();