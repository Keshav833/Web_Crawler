import * as cheerio from "cheerio";
import { createRequire } from "node:module";

type RobotsParser = typeof import("robots-parser").default;

const robotsParser: RobotsParser =
    createRequire(import.meta.url)("robots-parser");


let robots: ReturnType<RobotsParser> | null = null;

let activeWorkers = 0;
// let pendingTasks = 1;


const MAX_DEPTH = 2;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT = 5000;
const REQUEST_DELAY = 1000;
let lastRequestTime = 0;
const CONCURRENCY = 3; //means maximum 3 workers fetching pages simultaneously
const startUrl = "http://books.tscrape.com/";
const startDomain = new URL(startUrl).hostname;
const USER_AGENT = "MyCrawler/1.0";
const visited = new Set<string>();
const queued = new Set<string>([startUrl]);

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

//function that repeatedly takes one job from the queue and processes it
async function processUrl(item: QueueItem, id: number) {
    const { url, depth } = item;

    if (visited.has(url)) {
        return;
    }

    visited.add(url);

    if (robots && !robots.isAllowed(url, USER_AGENT)) {
        console.log(`Blocked by robots.txt: ${url}`);
        return;
    }

    activeWorkers++;

    console.log(
        `Worker ${id} processing: ${url} | Active: ${activeWorkers}`
    );

    try {
        // Existing rate-limiting logic
        // await waitForRateLimit();

        const html = await fetchPage(url);
        const $ = cheerio.load(html);

        console.log("Title:", $("title").text().trim());

        if (depth >= MAX_DEPTH) {
            return;
        }

        $("a").each((_, element) => {
            const href = $(element).attr("href");
            if (!href) return;

            const normalizedUrl = normalizeUrl(href, url);
            if (!normalizedUrl) return;

            if (new URL(normalizedUrl).hostname !== startDomain) {
                return;
            }

            if (!visited.has(normalizedUrl) && !queued.has(normalizedUrl)) {
                queued.add(normalizedUrl);

                queue.push({
                    url: normalizedUrl,
                    depth: depth + 1,
                });
            }
        });
    } catch (error) {
        console.log(`Worker ${id} failed: ${url}`, error);
    } finally {
        activeWorkers--;

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

async function fetchPage(url: string) {
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
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            return await response.text();

        } catch (error) {
            console.log(`Attempt ${attempt} failed for ${url}`);

            if (attempt === MAX_ATTEMPTS) {
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

    try {
        const response = await fetch(robotsUrl);

        if (!response.ok) {
            console.log("robots.txt not found or unavailable");
            return null;
        }

        const robotsText = await response.text();

        return robotsParser(robotsUrl, robotsText);
    } catch (error) {
        console.log("Could not fetch robots.txt");

        return null;
    }
}

function normalizeUrl(rawUrl: string, baseUrl: string): string | null {
    try {
        const url = new URL(rawUrl, baseUrl);

        // Only allow HTTP and HTTPS
        if (url.protocol !== "http:" && url.protocol !== "https:") {
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
    robots = await getRobotsParser(startUrl);

    while (queue.length > 0) {
        const batch = queue.splice(0, CONCURRENCY);

        await Promise.all(
            batch.map((item, index) =>
                processUrl(item, index + 1)
            )
        );
    }

    console.log("Crawling finished.");
}

crawl();



