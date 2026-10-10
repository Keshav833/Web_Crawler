import * as cheerio from "cheerio";
import { createRequire } from "node:module";

type RobotsParser = typeof import("robots-parser").default;
const robotsParser: RobotsParser = createRequire(import.meta.url)("robots-parser");

const MAX_DEPTH = 2;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT = 5000;
const startUrl = "https://www.vercel.com";
const startDomain = new URL(startUrl).hostname;
const USER_AGENT = "MyCrawler/1.0";

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

const visited = new Set<string>();

async function fetchPage(url: string) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT);

    try {
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
  const robots = await getRobotsParser(startUrl);

   
  while (queue.length > 0) {
    const currentUrl = queue.shift();

    if (!currentUrl) continue;

    const { url, depth } = currentUrl;
    console.log(`Crawling: ${url} | Depth: ${depth}`);

    // Skip already visited URLs
    if (visited.has(url)) {
      continue;
    }

    if (robots && !robots.isAllowed(url, USER_AGENT)) {
   console.log(`Blocked by robots.txt: ${url}`);
   continue;
   }
    visited.add(url);

   

    try {
            
        const html = await fetchPage(url);

      const $ = cheerio.load(html);

      const title = $("title").text().trim();

      console.log("Title:", title);

      $("a").each((_, element) => {
        const href = $(element).attr("href");

        if (!href) return;
        const normalizedUrl = normalizeUrl(href, url);

            if (!normalizedUrl) return;

          // Only crawl the same domain
          if (
            new URL(normalizedUrl).hostname === startDomain
          ) {
            // const normalizedUrl = absoluteUrl.href;

            if (!visited.has(normalizedUrl) && depth < MAX_DEPTH) {
              queue.push({
                url: normalizedUrl,
                depth: depth + 1,
              });
            }
          }
      });

    } catch (error) {
      console.log("Request failed:", url , error);
    }
  }
}



crawl();