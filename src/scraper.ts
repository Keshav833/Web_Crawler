import { pathToFileURL } from "node:url";
import { Crawler, crawl } from "./crawler.js";

export { Crawler, crawl };
export type {
    CrawlOptions,
    CrawlResult,
    CrawlStats,
} from "./crawler.js";

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    void crawl();
}
