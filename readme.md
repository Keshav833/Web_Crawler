# TypeScript Web Crawler

![CI](https://github.com/Keshav833/Web_Crawler/actions/workflows/ci.yml/badge.svg)

A configurable Node.js and TypeScript crawler that discovers same-host links, extracts basic page metadata, and exports results as JSON or CSV. It uses native HTTP by default and offers an optional Playwright backend for pages that need JavaScript rendering.

## Why this project

It brings URL discovery, crawl controls, basic extraction, and export into one reusable tool instead of requiring a custom one-off script for each small crawling task.

## Tech stack

- Node.js and TypeScript
- Native `fetch` for the default HTTP backend
- Cheerio for HTML parsing
- Playwright and Chromium as optional browser support
- Vitest for automated tests

## What it does

- Crawls HTTP(S) pages on the starting URL's hostname, with a configurable depth and unique-URL limit.
- Normalizes links, removes fragments and common tracking parameters, and filters unsupported file extensions.
- Checks `robots.txt` before crawling pages and uses a descriptive crawler user-agent.
- Supports concurrent workers, request-start pacing, retries, and timeouts.
- Extracts page title, meta description, headings, link count, and URL.
- Exports results as JSON or CSV.
- Optionally renders pages with Playwright and Chromium.

## Requirements

- Node.js `20.18.1` or newer.
- npm.

## Install

Clone the repository, then install the exact dependency versions from the lockfile:

```bash
npm ci
```

For browser mode, install the Playwright-managed Chromium browser once:

```bash
npx playwright install chromium
```

The Playwright package is an optional dependency. HTTP mode does not require the browser binary.

## Quick start

Run the crawler with the default start URL and settings:

```bash
npm run crawl
```

To use the local dashboard instead of the CLI, start the web interface:

```bash
npm run web
```

Open `http://127.0.0.1:3000` in your browser. The dashboard shows crawl progress and page data and provides JSON and CSV downloads. Stop the local server with Ctrl+C. By default, the server binds to loopback and cannot be reached from other machines.

The dashboard offers the core crawl settings, live progress and statistics, a searchable/sortable results table, and a detail view for each page. Results remain in memory until a new crawl starts or the server stops; the crawler also writes its JSON results to `results.json` in the server's working directory.

## Public deployment on Render

The public deployment is opt-in and intentionally more restricted than local use. It requires a crawl password and an explicit hostname allowlist, accepts HTTPS targets only, limits crawls to depth 3, 100 pages, 2 workers, and at least 1 second between requests, caps each HTML response at 1 MB, and disables browser mode. It also limits redirects to the approved crawl hostname. Keep the allowlist to public sites you own or are authorized to crawl; the crawler still checks `robots.txt`.

1. Push the repository to GitHub, then create a Render Blueprint using the repository's `render.yaml`.
2. Set the required environment variables when prompted:
   - `PUBLIC_DEPLOYMENT`: `true` (set by the Blueprint)
   - `PUBLIC_ORIGIN`: the exact HTTPS origin Render assigns, such as `https://web-crawler-dashboard.onrender.com`
   - `DASHBOARD_PASSWORD`: a strong random password of at least 20 bytes. Generate one locally with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` and keep it in Render's environment settings, not in Git.
   - `CRAWL_ALLOWED_HOSTS`: comma-separated hostnames only, without schemes or paths, for example `books.toscrape.com`
3. Render builds with `npm ci && npm run build` and starts with `npm run start:web`. Visit the Render HTTPS URL; visitors can view the dashboard and results, but must enter the password to start a crawl.

The dashboard binds to all interfaces only when `PUBLIC_DEPLOYMENT=true`. It validates the configured public origin and forwarded HTTPS requests. Do not remove the password, hostname allowlist, or crawl limits, and do not publish secrets in issues or logs. Crawls and results are in memory and disappear when the service restarts; the filesystem may also be ephemeral. Anyone who can access the public dashboard can see the current crawl's results and status. Render plan availability, sleep behavior, and resource limits depend on the selected plan.

Local use remains loopback-only unless `PUBLIC_DEPLOYMENT=true` and all public settings are configured.

Or specify a target and output:

```bash
npm run crawl -- --url https://books.toscrape.com/ --depth 2 --output results.json
```

The default start URL is Books to Scrape, a site intended for scraping practice. Check its current policies and `robots.txt` before crawling.

## CLI

Use `npm run crawl -- --help` to print the usage. Options are:

On Windows PowerShell, use `npm.cmd` for CLI invocations if argument forwarding through `npm` does not work, for example `npm.cmd run crawl -- --help`.

| Option | Default | Accepted values / limits |
| --- | --- | --- |
| `--url <url>` | `https://books.toscrape.com/` | Absolute HTTP(S) URL without embedded credentials |
| `--depth <number>` | `2` | Whole number from `0` to `10` |
| `--concurrency <number>` | `3` | HTTP: `1` to `10`; browser: `1` to `3` |
| `--delay <ms>` | `1000` | Whole number, at least `100`; minimum interval between request starts |
| `--max-pages <number>` | `1000` | Whole number from `1` to `10000`; maximum unique URLs queued |
| `--output <path>` | `results.json` | Output path; its parent directory must already exist |
| `--format <format>` | `json` | `json` or `csv` |
| `--mode <mode>` | `http` | `http` or `browser` |
| `--navigation-timeout <ms>` | `10000` | Whole number from `1` to `120000`; browser navigation only |
| `--help`, `-h` | — | Print help |

HTTP mode uses Node's native `fetch` and is the default:

```bash
npm run crawl -- --url https://books.toscrape.com/ --mode http --depth 2 --concurrency 3 --delay 1000
```

Browser mode renders JavaScript with Chromium:

```bash
npm run crawl -- --url https://example.com/ --mode browser --depth 1 --concurrency 2 --delay 1000 --navigation-timeout 15000
```

Browser mode waits for `domcontentloaded`, reuses one browser process, and creates and closes an isolated browser context for each page. `networkidle` is not used because pages with persistent connections may never become idle.

## Results

JSON output is an array of page records:

```json
[
  {
    "url": "https://example.com/",
    "title": "Example",
    "description": "An example page",
    "headings": ["Example heading"],
    "linksCount": 1
  }
]
```

CSV uses the columns `url`, `title`, `description`, `headings`, and `linksCount`. The `headings` array is encoded as JSON in its CSV cell; cells containing commas, quotes, or newlines are escaped. Empty results produce valid empty JSON (`[]`) or a CSV header row.

```csv
url,title,description,headings,linksCount
https://example.com/,Example,An example page,"[""Example heading""]",1
```

The CLI prints a progress message every ten completed URLs and a final report with discovered and queued URL counts, scraped/failed/skipped counts, maximum observed concurrency, elapsed time, and export path. `discoveredUrls` counts normalized same-host links encountered (including duplicate encounters); `queuedUrls` counts unique URLs admitted, including the seed. Unsupported content types and robots-disallowed pages are skipped, not counted as successfully scraped.

## Use as a library

After building the package, import `Crawler` from the package or its built entry point:

```ts
import { Crawler } from "web_crawler";

const crawler = new Crawler({
  startUrl: "https://books.toscrape.com/",
  maxDepth: 2,
  concurrency: 3,
  requestDelayMs: 1000,
});

const result = await crawler.crawl();
if (result) {
  console.log(result.pages);
  console.log(result.stats);
}
```

`crawl()` returns `{ pages, stats }` after a crawl and export, or `null` if the robots policy cannot be retrieved. Export errors are thrown. The constructor accepts the CLI configuration options; browser users can set `mode: "browser"` and `navigationTimeoutMs`. The library also exports `crawl(options)` for callers that only need the resulting statistics.

Build the package with:

```bash
npm run build
```

## Development and tests

```bash
npm ci
npx tsc --noEmit
npm test
npm run build
```

The tests use Vitest. Browser integration tests use locally controlled HTTP pages and require the Playwright Chromium browser to be installed as described above.

## Project layout

```text
src/
  browser-fetcher.ts      Optional Playwright backend
  cli.ts                  CLI entry point
  config.ts               CLI parsing, defaults, and validation
  crawler.ts              Queue, workers, robots checks, and crawl statistics
  fetcher.ts              HTTP fetching, retries, and shared request pacing
  web-server.ts           Local dashboard API and opt-in restricted public mode
  web.ts                  Dashboard server entry point
  index.ts                Public library exports
  parser.ts               HTML extraction using Cheerio
  robots.ts               robots.txt retrieval and policy
  scraper.ts              Legacy direct-entry wrapper
  url.ts                  URL normalization and filtering
  types.ts                Shared page-result type
  exporters/              JSON and CSV serialization and file writing
tests/                    Vitest unit and integration tests
public/                   Local dashboard HTML, CSS, and browser-side JavaScript
.github/                  CI workflow and contribution templates
render.yaml               Render Blueprint for the public dashboard deployment
CONTRIBUTING.md           Development and contribution guidance
LICENSE                   ISC license
```

## Responsible use

Use this crawler only on public pages or pages you are authorized to access. Review the site's terms and `robots.txt`, use a reasonable delay and concurrency, and stop if the site owner requests it. The crawler does not bypass authentication, CAPTCHAs, access controls, or robots rules. Discovered links are limited to the starting hostname, but redirects are not independently restricted or checked against the destination host's robots policy. Browser mode may also load third-party resources referenced by a page. Use it only when those destinations are appropriate for the target.

## Limitations

- Crawling is restricted to links on the starting hostname; this is not a general distributed crawler.
- Only the configured number of unique URLs can be queued, and crawl depth is capped at ten.
- Extraction is intentionally basic: title, meta description, `h1`/`h2`/`h3` text, and link count.
- Browser mode requires downloading Chromium and uses more resources than HTTP mode.
- Response sizes and total crawl memory use are not capped; very large pages or result sets can use substantial memory.
- The project does not provide a database, sitemap discovery, proxy support, or authentication workflows.
- The export writer does not create missing parent directories.

## Contributing

Bug reports and pull requests are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, testing, and contribution guidelines. Please include a focused test for behavior changes and follow the responsible-use requirements above.

## License

This project is distributed under the ISC license. See [LICENSE](./LICENSE).
