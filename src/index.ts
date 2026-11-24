export { Crawler, crawl } from "./crawler.js";
export type {
    CrawlOptions,
    CrawlProgress,
    CrawlProgressListener,
    CrawlResult,
    CrawlStats,
} from "./crawler.js";
export type { CrawlerConfig } from "./config.js";
export type { PageResult, ExtractionConfig, StructuredData, ErrorLog, UrlFilterConfig } from "./types.js";

// New exports for enhanced features
export { ErrorTracker, categorizeError, isRetryableError } from "./error-tracker.js";
export { UrlFilter, URL_FILTER_PRESETS, isLikelyFile, isLikelyTrackingUrl } from "./url-filter.js";
export {
    extractStructuredData,
    extractCustomFields,
} from "./structured-data-extractor.js";
export { discoverSitemapUrls, fetchAllSitemapUrls, parseSitemapDirective } from "./sitemap.js";
