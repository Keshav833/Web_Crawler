# Web Crawler & Scraper

An open-source web crawling and scraping engine built with **Node.js and TypeScript**.

The goal is to build a reusable tool that can:

-  Crawl websites and discover URLs
-  Extract structured data from web pages
-  Normalize and manage discovered URLs
-  Respect `robots.txt` and crawl responsibly
-  Handle concurrency, retries, and rate limiting
-  Use **Playwright** for JavaScript-rendered websites
-  Store and export scraped data

### Project structure

```text
src/
  cli.ts
  config.ts
  crawler.ts
  browser-fetcher.ts
  fetcher.ts
  index.ts
  parser.ts
  robots.ts
  scraper.ts
  types.ts
  url.ts
  exporters/
    csv.ts
    index.ts
    json.ts
tests/
```

The project focuses on learning and implementing the core concepts behind **web crawling, web scraping, and browser automation** while providing a practical open-source tool for developers.

## Run the crawler

```bash
npm install
npm run crawl -- --url https://books.toscrape.com/ --depth 2 --concurrency 3 --delay 1000 --max-pages 1000 --output results.json --format json
```

Run `npm run crawl -- --help` to see all options. Defaults are the Books to Scrape start URL, depth `2`, concurrency `3`, a `1000` ms minimum request-start interval, a `1000` unique-URL page limit, and `results.json` output in JSON format. Choose CSV with `--format csv --output results.csv`.

The CLI accepts only absolute HTTP(S) URLs without embedded credentials. It limits depth to `0-10`, HTTP concurrency to `1-10` (browser concurrency to `1-3`), delay to at least `100` ms, and the unique URLs admitted to the crawl to `1-10000`. CSV encodes the headings array as a JSON array in its cell and follows standard quote escaping.

HTTP is the default backend. To render JavaScript, install Chromium once with `npx playwright install chromium`, then select browser mode:

```bash
npm run crawl -- --url https://example.com/ --mode browser --depth 1 --concurrency 2 --delay 1000 --navigation-timeout 15000
```

Browser mode uses a shared Chromium process and a new isolated context per page, waits for `domcontentloaded`, and closes each context after navigation. Browser concurrency is limited to `1-3` workers to control resource use; `--navigation-timeout` accepts `1-120000` milliseconds and defaults to `10000`. Browser mode is intended for public or explicitly authorized pages. It does not bypass robots rules, authentication, CAPTCHAs, or access controls.

The crawler prints a progress summary every 10 completed URLs and a final report with scraped, failed, and skipped pages; discovered and queued URL counts; maximum concurrency; elapsed milliseconds; and export path. Errors are written separately from policy/content skips.

## Use as a library

The CLI uses the same `Crawler` API available to TypeScript callers:

```ts
import { Crawler } from "web_crawler";

const crawler = new Crawler({
  startUrl: "https://books.toscrape.com/",
  maxDepth: 2,
  concurrency: 3,
});

const result = await crawler.crawl();
if (result) {
  console.log(result.pages);
  console.log(result.stats);
}
```

`crawl()` returns `null` if the crawler cannot retrieve the site's robots policy; otherwise it returns `{ pages, stats }` and exports the pages to the configured path.

Run `npm run build` before importing the package from another Node.js application.