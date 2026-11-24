import { performance } from "node:perf_hooks";
import { fetchPage, USER_AGENT, type FetchPageOptions } from "./fetcher.js";
import { BrowserFetcher } from "./browser-fetcher.js";
import { exportResults } from "./exporters/index.js";
import {
    resolveCrawlerConfig,
    type CrawlerConfig,
} from "./config.js";
import { parsePage } from "./parser.js";
import { getRobotsParser, type RobotsPolicy } from "./robots.js";
import { normalizeUrl } from "./url.js";
import type { PageResult } from "./types.js";
import { ErrorTracker, isRetryableError } from "./error-tracker.js";
import { UrlFilter } from "./url-filter.js";
import { discoverSitemapUrls } from "./sitemap.js";

type QueueItem = {
    url: string;
    depth: number;
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
    crawlDurationMs: number;
    exportPath: string;
    errorStats?: Record<string, number>;
};

export type CrawlOptions = Partial<CrawlerConfig> & {
    fetchPageOptions?: FetchPageOptions;
    onProgress?: CrawlProgressListener;
    shouldCrawlUrl?: (url: string) => boolean;
};

export type CrawlResult = {
    pages: PageResult[];
    stats: CrawlStats;
};

export type CrawlProgress = Omit<CrawlStats, "crawlDurationMs" | "exportPath"> & {
    completedPages: number;
};

export type CrawlProgressListener = (progress: CrawlProgress) => void;

const PROGRESS_LOG_INTERVAL = 10;
const MAX_CRAWL_RESULT_BYTES = 50_000_000;

export class Crawler {
    private readonly config: CrawlerConfig;
    private readonly fetchPageOptions: FetchPageOptions;
    private readonly onProgress: CrawlProgressListener | undefined;
    private readonly shouldCrawlUrl: ((url: string) => boolean) | undefined;
    private browserFetcher: BrowserFetcher | undefined;
    private robots: RobotsPolicy | null = null;
    private activeWorkers = 0;
    private readonly visited = new Set<string>();
    private readonly queued = new Set<string>();
    private readonly results: PageResult[] = [];
    private readonly queue: QueueItem[] = [];
    private readonly crawlStats = {
        discoveredUrls: 0,
        queuedUrls: 0,
        scrapedPages: 0,
        failedPages: 0,
        skippedPages: 0,
        maxObservedConcurrency: 0,
    };
    private outstandingTasks = 0;
    private resultBytes = 0;
    private resultLimitReached = false;
    private readonly waitingWorkers = new Set<() => void>();
    private crawlInProgress = false;
    private errorTracker = new ErrorTracker();
    private urlFilter: UrlFilter | undefined;
    private sitemapUrls: Set<string> = new Set();

    constructor(options: CrawlOptions = {}) {
        const {
            fetchPageOptions = {},
            onProgress,
            shouldCrawlUrl,
            ...configOverrides
        } = options;
        this.config = resolveCrawlerConfig(configOverrides);
        this.onProgress = onProgress;
        this.shouldCrawlUrl = shouldCrawlUrl;
        this.fetchPageOptions = {
            ...fetchPageOptions,
            requestDelayMs:
                fetchPageOptions.requestDelayMs ?? this.config.requestDelayMs,
        };

        // Initialize URL filter if configured
        if (this.config.urlFilters) {
            this.urlFilter = new UrlFilter(this.config.urlFilters);
        }

        this.resetCrawlState();
    }

    async crawl(): Promise<CrawlResult | null> {
        if (this.crawlInProgress) {
            throw new Error("A crawl is already in progress");
        }

        this.crawlInProgress = true;
        const crawlStartedAt = performance.now();

        try {
            this.resetCrawlState();
            try {
                this.robots = await getRobotsParser(
                    this.config.startUrl,
                    undefined,
                    this.fetchPageOptions.allowedRedirectHosts,
                    this.fetchPageOptions.maxResponseBytes
                );
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);
                console.error(
                    `Crawling stopped; refusing to fetch pages because robots.txt could not be checked: ${message}`
                );
                return null;
            }

            if (this.config.mode === "browser") {
                this.browserFetcher = new BrowserFetcher();
                await this.browserFetcher.initialize();
            }

            const startDomain = new URL(this.config.startUrl).hostname;

            // Discover sitemaps if requested
            if (this.config.extractionConfig?.followSitemaps) {
                try {
                    const origin = new URL(this.config.startUrl).origin;
                    const sitemapUrls = await discoverSitemapUrls(origin);
                    sitemapUrls.forEach((url) => this.sitemapUrls.add(url));
                    console.log(`Discovered ${sitemapUrls.length} URLs from sitemaps`);
                } catch (error) {
                    console.warn("Failed to discover sitemaps:", error);
                }
            }

            await Promise.all(
                Array.from(
                    { length: this.config.concurrency },
                    (_, index) => this.worker(index + 1, startDomain)
                )
            );

            await exportResults(
                this.results,
                this.config.outputPath,
                this.config.format
            );

            const stats: CrawlStats = {
                ...this.crawlStats,
                activeWorkers: this.activeWorkers,
                outstandingTasks: this.outstandingTasks,
                crawlDurationMs: Math.round(
                    performance.now() - crawlStartedAt
                ),
                exportPath: this.config.outputPath,
                errorStats: this.config.includeErrorDetails
                    ? this.errorTracker.getStats()
                    : undefined,
            };

            console.log("Crawling finished.", stats);

            return {
                pages: this.results.map((page) => ({
                    ...page,
                    headings: [...page.headings],
                })),
                stats,
            };
        } finally {
            const browserFetcher = this.browserFetcher;
            this.browserFetcher = undefined;
            try {
                await browserFetcher?.close();
            } finally {
                this.crawlInProgress = false;
            }
        }
    }

    private resetCrawlState(): void {
        const startUrl = this.config.startUrl;
        this.robots = null;
        this.activeWorkers = 0;
        this.visited.clear();
        this.queued.clear();
        this.queued.add(startUrl);
        this.results.length = 0;
        this.queue.splice(0, this.queue.length, { url: startUrl, depth: 0 });
        this.crawlStats.discoveredUrls = 1;
        this.crawlStats.queuedUrls = 1;
        this.crawlStats.scrapedPages = 0;
        this.crawlStats.failedPages = 0;
        this.crawlStats.skippedPages = 0;
        this.crawlStats.maxObservedConcurrency = 0;
        this.outstandingTasks = 1;
        this.resultBytes = 0;
        this.resultLimitReached = false;
        this.waitingWorkers.clear();
    }

    private notifyWaitingWorkers(): void {
        const waiters = [...this.waitingWorkers];
        this.waitingWorkers.clear();
        for (const wake of waiters) {
            wake();
        }
    }

    private waitForQueueChange(): Promise<void> {
        return new Promise((resolve) => {
            this.waitingWorkers.add(resolve);
        });
    }

    private enqueueUrl(item: QueueItem): void {
        if (this.visited.has(item.url) || this.queued.has(item.url)) {
            return;
        }

        // Apply URL filter if configured
        if (this.urlFilter && !this.urlFilter.shouldInclude(item.url)) {
            return;
        }

        // Apply custom filter if provided
        if (this.shouldCrawlUrl && !this.shouldCrawlUrl(item.url)) {
            return;
        }

        if (this.crawlStats.queuedUrls >= this.config.maxPages) {
            return;
        }

        this.queued.add(item.url);
        this.queue.push(item);
        this.crawlStats.queuedUrls++;
        this.outstandingTasks++;
        this.notifyWaitingWorkers();
    }

    private async processUrl(
        item: QueueItem,
        id: number,
        startDomain: string
    ): Promise<ProcessOutcome> {
        const { url, depth } = item;

        if (this.visited.has(url)) {
            return "skipped";
        }

        this.visited.add(url);
        if (this.resultLimitReached) {
            return "skipped";
        }
        this.activeWorkers++;
        this.crawlStats.maxObservedConcurrency = Math.max(
            this.crawlStats.maxObservedConcurrency,
            this.activeWorkers
        );

        try {
            if (this.robots && !this.robots.isAllowed(url, USER_AGENT)) {
                console.log(`Blocked by robots.txt: ${url}`);
                return "skipped";
            }

            const html = this.browserFetcher
                ? await this.browserFetcher.fetchPage(url, {
                      ...this.fetchPageOptions,
                      timeoutMs:
                          this.fetchPageOptions.timeoutMs ??
                          this.config.navigationTimeoutMs,
                  })
                : await fetchPage(url, this.fetchPageOptions);
            if (html === null) {
                return "skipped";
            }

            const { result, links } = parsePage(
                html,
                url,
                this.config.extractionConfig
            );
            if (this.resultLimitReached) {
                return "skipped";
            }
            const resultBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
            if (this.resultBytes + resultBytes > MAX_CRAWL_RESULT_BYTES) {
                this.resultLimitReached = true;
                console.error(
                    `Stopping result collection because the ${MAX_CRAWL_RESULT_BYTES}-byte crawl result limit was reached`
                );
                return "failed";
            }

            if (depth < this.config.maxDepth) {
                for (const href of links) {
                    const normalizedUrl = normalizeUrl(href, url);
                    if (
                        !normalizedUrl ||
                         new URL(normalizedUrl).hostname !== startDomain ||
                         (this.shouldCrawlUrl !== undefined &&
                             !this.shouldCrawlUrl(normalizedUrl))
                    ) {
                        continue;
                    }

                    this.crawlStats.discoveredUrls++;
                    this.enqueueUrl({
                        url: normalizedUrl,
                        depth: depth + 1,
                    });
                }
            }

            this.results.push(result);
            this.resultBytes += resultBytes;
            return "scraped";
        } catch (error) {
            const statusCode =
                error instanceof Error &&
                "statusCode" in error
                    ? (error.statusCode as number | undefined)
                    : undefined;

            this.errorTracker.recordError(url, error, statusCode);
            if (this.config.includeErrorDetails) {
                // Add error entry to results if configured
                const errorResult: PageResult = {
                    url,
                    title: "",
                    description: "",
                    headings: [],
                    linksCount: 0,
                    crawledAt: Date.now(),
                    statusCode,
                    error:
                        error instanceof Error
                            ? error.message
                            : String(error),
                };
                this.results.push(errorResult);
            }
            console.error(`Worker ${id} failed to process ${url}`, error);
            return "failed";
        } finally {
            this.activeWorkers--;
        }
    }

    private async worker(id: number, startDomain: string): Promise<void> {
        while (true) {
            const item = this.queue.shift();
            if (!item) {
                if (this.outstandingTasks === 0) {
                    return;
                }

                await this.waitForQueueChange();
                continue;
            }

            let outcome: ProcessOutcome = "failed";
            try {
                outcome = await this.processUrl(item, id, startDomain);
            } catch (error) {
                console.error(
                    `Worker ${id} encountered an unexpected error`,
                    error
                );
            } finally {
                this.outstandingTasks--;
                this.notifyWaitingWorkers();
            }

            switch (outcome) {
                case "scraped":
                    this.crawlStats.scrapedPages++;
                    break;
                case "skipped":
                    this.crawlStats.skippedPages++;
                    break;
                case "failed":
                    this.crawlStats.failedPages++;
                    break;
            }

            const completedPages =
                this.crawlStats.scrapedPages +
                this.crawlStats.failedPages +
                this.crawlStats.skippedPages;
            try {
                this.onProgress?.({
                    ...this.crawlStats,
                    completedPages,
                    activeWorkers: this.activeWorkers,
                    outstandingTasks: this.outstandingTasks,
                });
            } catch (error) {
                console.error("Crawl progress listener failed", error);
            }

            if (completedPages % PROGRESS_LOG_INTERVAL === 0) {
                console.log("Crawl progress:", {
                    completedPages,
                    ...this.crawlStats,
                    activeWorkers: this.activeWorkers,
                    outstandingTasks: this.outstandingTasks,
                });
            }
        }
    }
}

export async function crawl(
    options: CrawlOptions = {}
): Promise<CrawlStats | null> {
    const result = await new Crawler(options).crawl();
    return result?.stats ?? null;
}
