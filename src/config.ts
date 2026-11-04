export type CrawlerConfig = {
    startUrl: string;
    maxDepth: number;
    concurrency: number;
    requestDelayMs: number;
    maxPages: number;
    outputPath: string;
    format: "json" | "csv";
    mode: "http" | "browser";
    navigationTimeoutMs: number;
};

export type CliConfig = CrawlerConfig;

export type CliParseResult =
    | { kind: "help" }
    | { kind: "config"; config: CliConfig };

export const DEFAULT_CRAWLER_CONFIG: CrawlerConfig = {
    startUrl: "https://books.toscrape.com/",
    maxDepth: 2,
    concurrency: 3,
    requestDelayMs: 1000,
    maxPages: 1000,
    outputPath: "results.json",
    format: "json",
    mode: "http",
    navigationTimeoutMs: 10_000,
};

const MAX_DEPTH = 10;
const MAX_CONCURRENCY = 10;
const MAX_BROWSER_CONCURRENCY = 3;
const MIN_REQUEST_DELAY_MS = 100;
const MAX_PAGES = 10000;
const MAX_NAVIGATION_TIMEOUT_MS = 120_000;

function parseBoundedInteger(
    value: string,
    option: string,
    minimum: number,
    maximum: number
): number {
    if (!/^\d+$/.test(value)) {
        throw new Error(`${option} must be a whole number`);
    }

    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new Error(
            `${option} must be between ${minimum} and ${maximum}`
        );
    }

    return parsed;
}

export function resolveCrawlerConfig(
    overrides: Partial<CrawlerConfig> = {}
): CrawlerConfig {
    const config = { ...DEFAULT_CRAWLER_CONFIG, ...overrides };

    let url: URL;
    try {
        url = new URL(config.startUrl);
    } catch {
        throw new Error("--url must be a valid absolute URL");
    }

    if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        !url.hostname ||
        url.username ||
        url.password
    ) {
        throw new Error("--url must be an HTTP(S) URL without embedded credentials");
    }

    if (!Number.isInteger(config.maxDepth) || config.maxDepth < 0 || config.maxDepth > MAX_DEPTH) {
        throw new Error(`--depth must be between 0 and ${MAX_DEPTH}`);
    }
    if (
        !Number.isInteger(config.concurrency) ||
        config.concurrency < 1 ||
        config.concurrency > MAX_CONCURRENCY
    ) {
        throw new Error(`--concurrency must be between 1 and ${MAX_CONCURRENCY}`);
    }
    if (config.mode !== "http" && config.mode !== "browser") {
        throw new Error("--mode must be http or browser");
    }
    if (config.mode === "browser" && config.concurrency > MAX_BROWSER_CONCURRENCY) {
        throw new Error(
            `--concurrency must be between 1 and ${MAX_BROWSER_CONCURRENCY} in browser mode`
        );
    }
    if (
        !Number.isInteger(config.requestDelayMs) ||
        config.requestDelayMs < MIN_REQUEST_DELAY_MS
    ) {
        throw new Error(`--delay must be a whole number of at least ${MIN_REQUEST_DELAY_MS}`);
    }
    if (
        !Number.isInteger(config.maxPages) ||
        config.maxPages < 1 ||
        config.maxPages > MAX_PAGES
    ) {
        throw new Error(`--max-pages must be between 1 and ${MAX_PAGES}`);
    }
    if (
        !Number.isInteger(config.navigationTimeoutMs) ||
        config.navigationTimeoutMs < 1 ||
        config.navigationTimeoutMs > MAX_NAVIGATION_TIMEOUT_MS
    ) {
        throw new Error(
            `--navigation-timeout must be between 1 and ${MAX_NAVIGATION_TIMEOUT_MS} milliseconds`
        );
    }
    if (!config.outputPath.trim()) {
        throw new Error("--output must not be empty");
    }
    if (config.format !== "json" && config.format !== "csv") {
        throw new Error("--format must be json or csv");
    }

    return config;
}

export function parseCliArgs(args: string[]): CliParseResult {
    if (args.includes("--help") || args.includes("-h")) {
        return { kind: "help" };
    }

    const values: Record<string, string> = {};
    const supportedOptions = new Set([
        "--url",
        "--depth",
        "--concurrency",
        "--delay",
        "--max-pages",
        "--output",
        "--format",
        "--mode",
        "--navigation-timeout",
    ]);

    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        if (argument === undefined) {
            continue;
        }

        const separator = argument.indexOf("=");
        const option = separator < 0 ? argument : argument.slice(0, separator);
        if (!supportedOptions.has(option)) {
            throw new Error(`Unknown option: ${option}`);
        }
        if (Object.hasOwn(values, option)) {
            throw new Error(`Option ${option} may only be specified once`);
        }

        let value: string | undefined;
        if (separator >= 0) {
            value = argument.slice(separator + 1);
        } else {
            index++;
            value = args[index];
        }

        if (value === undefined || value.length === 0 || value.startsWith("--")) {
            throw new Error(`Option ${option} requires a value`);
        }

        values[option] = value;
    }

    const overrides: Partial<CrawlerConfig> = {};
    if (values["--url"] !== undefined) {
        overrides.startUrl = values["--url"];
    }
    if (values["--depth"] !== undefined) {
        overrides.maxDepth = parseBoundedInteger(
            values["--depth"],
            "--depth",
            0,
            MAX_DEPTH
        );
    }
    if (values["--concurrency"] !== undefined) {
        overrides.concurrency = parseBoundedInteger(
            values["--concurrency"],
            "--concurrency",
            1,
            MAX_CONCURRENCY
        );
    }
    if (values["--delay"] !== undefined) {
        const requestDelayMs = parseBoundedInteger(
            values["--delay"],
            "--delay",
            0,
            Number.MAX_SAFE_INTEGER
        );
        if (requestDelayMs < MIN_REQUEST_DELAY_MS) {
            throw new Error(
                `--delay must be at least ${MIN_REQUEST_DELAY_MS} milliseconds`
            );
        }
        overrides.requestDelayMs = requestDelayMs;
    }
    if (values["--max-pages"] !== undefined) {
        overrides.maxPages = parseBoundedInteger(
            values["--max-pages"],
            "--max-pages",
            1,
            MAX_PAGES
        );
    }
    if (values["--navigation-timeout"] !== undefined) {
        overrides.navigationTimeoutMs = parseBoundedInteger(
            values["--navigation-timeout"],
            "--navigation-timeout",
            1,
            MAX_NAVIGATION_TIMEOUT_MS
        );
    }
    if (values["--output"] !== undefined) {
        overrides.outputPath = values["--output"];
    }

    const format = values["--format"] ?? "json";
    if (format !== "json" && format !== "csv") {
        throw new Error("--format must be json or csv");
    }
    overrides.format = format;

    const mode = values["--mode"] ?? "http";
    if (mode !== "http" && mode !== "browser") {
        throw new Error("--mode must be http or browser");
    }
    overrides.mode = mode;

    return {
        kind: "config",
        config: resolveCrawlerConfig(overrides),
    };
}

export const CLI_HELP = `Usage: npm run crawl -- [options]

Options:
  --url <url>              Starting HTTP(S) URL (default: ${DEFAULT_CRAWLER_CONFIG.startUrl})
  --depth <number>         Maximum link depth, 0-10 (default: ${DEFAULT_CRAWLER_CONFIG.maxDepth})
  --concurrency <number>   Worker count: 1-10 for HTTP, 1-3 for browser (default: ${DEFAULT_CRAWLER_CONFIG.concurrency})
  --delay <ms>             Minimum request-start interval, at least ${MIN_REQUEST_DELAY_MS} ms (default: ${DEFAULT_CRAWLER_CONFIG.requestDelayMs})
  --max-pages <number>     Maximum unique URLs queued, 1-10000 (default: ${DEFAULT_CRAWLER_CONFIG.maxPages})
  --output <path>           Output file path (default: ${DEFAULT_CRAWLER_CONFIG.outputPath})
  --format <format>         Output format: json or csv (default: ${DEFAULT_CRAWLER_CONFIG.format})
  --mode <mode>             Fetching backend: http or browser (default: ${DEFAULT_CRAWLER_CONFIG.mode})
  --navigation-timeout <ms> Browser navigation timeout, 1-120000 ms (default: ${DEFAULT_CRAWLER_CONFIG.navigationTimeoutMs})
  --help, -h                Show this help

Example:
  npm run crawl -- --url https://books.toscrape.com/ --depth 2 --concurrency 3 --delay 1000 --max-pages 1000 --output results.json --format json --mode http
  npm run crawl -- --url https://example.com/ --mode browser --concurrency 2 --navigation-timeout 15000`;
