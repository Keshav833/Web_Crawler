import * as cheerio from "cheerio";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { fetchPage, USER_AGENT, type FetchPageOptions } from "./fetcher.js";
import { normalizeUrl } from "./url.js";
import { getRobotsParser, type RobotsPolicy } from "./robots.js";

let robots: RobotsPolicy | null = null;
let activeWorkers = 0;

const MAX_DEPTH = 2;
const CONCURRENCY = 3; // Fixed number of URL-processing workers.
const startUrl = "https://books.toscrape.com/";
const startDomain = new URL(startUrl).hostname;
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
let crawlInProgress = false;

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

export type CrawlStats = {
    discoveredUrls: number;
    queuedUrls: number;
    scrapedPages: number;
    failedPages: number;
    skippedPages: number;
    maxObservedConcurrency: number;
    activeWorkers: number;
    outstandingTasks: number;
};

export type CrawlOptions = {
    fetchPageOptions?: FetchPageOptions;
    outputPath?: string;
};

// Processes one URL and returns its outcome.
async function processUrl(
    item: QueueItem,
    id: number,
    fetchPageOptions: FetchPageOptions | undefined
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

        const html = await fetchPage(url, fetchPageOptions);
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

async function worker(
    id: number,
    fetchPageOptions: FetchPageOptions | undefined
): Promise<void> {
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
            outcome = await processUrl(item, id, fetchPageOptions);
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

function resetCrawlState(): void {
    robots = null;
    activeWorkers = 0;
    visited.clear();
    queued.clear();
    queued.add(startUrl);
    results.length = 0;
    queue.splice(0, queue.length, { url: startUrl, depth: 0 });
    crawlStats.discoveredUrls = 1;
    crawlStats.queuedUrls = 1;
    crawlStats.scrapedPages = 0;
    crawlStats.failedPages = 0;
    crawlStats.skippedPages = 0;
    crawlStats.maxObservedConcurrency = 0;
    outstandingTasks = queue.length;
    waitingWorkers.clear();
}

async function runCrawl(
    options: CrawlOptions
): Promise<CrawlStats | null> {
  try {
    robots = await getRobotsParser(startUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Crawling stopped; refusing to fetch pages because robots.txt could not be checked: ${message}`
    );
    return null;
  }

  await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, index) =>
      worker(index + 1, options.fetchPageOptions)
    )
  );

  await writeFile(
    options.outputPath ?? "results.json",
    JSON.stringify(results, null, 2),
    "utf-8"
  );

  const stats: CrawlStats = {
    ...crawlStats,
    activeWorkers,
    outstandingTasks,
  };

  console.log("Crawling finished.");
  console.log("Crawl statistics:", {
    ...stats,
  });
  console.log(`Results saved to ${options.outputPath ?? "results.json"}`);
  return stats;
}

export async function crawl(
    options: CrawlOptions = {}
): Promise<CrawlStats | null> {
    if (crawlInProgress) {
        throw new Error("A crawl is already in progress");
    }

    crawlInProgress = true;
    resetCrawlState();
    try {
        return await runCrawl(options);
    } finally {
        crawlInProgress = false;
    }
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    void crawl();
}