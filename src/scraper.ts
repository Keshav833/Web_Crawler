import * as cheerio from "cheerio";

const MAX_DEPTH = 2;
const startUrl = "https://vercel.com";
const startDomain = new URL(startUrl).hostname;

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
  while (queue.length > 0) {
    const currentUrl = queue.shift();

    if (!currentUrl) continue;

    const { url, depth } = currentUrl;
    console.log(`Crawling: ${url} | Depth: ${depth}`);

    // Skip already visited URLs
    if (visited.has(url)) {
      continue;
    }

    visited.add(url);

    // console.log("\nCrawling:", currentUrl);

    try {
      const response = await fetch(url);

      if (!response.ok) {
        console.log("Failed:", response.status);
        continue;
      }

      const html = await response.text();

      const $ = cheerio.load(html);

      const title = $("title").text().trim();

      console.log("Title:", title);

      $("a").each((_, element) => {
        const href = $(element).attr("href");

        if (!href) return;

        try {
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
        } catch {
          // Ignore invalid URLs
        }
      });

    } catch (error) {
      console.log("Request failed:", url , error);
    }
  }
}



crawl();