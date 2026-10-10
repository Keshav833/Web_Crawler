import * as cheerio from "cheerio";

const startUrl = "https://vercel.com";

const queue: string[] = [startUrl];
const visited = new Set<string>();

async function crawl() {
  while (queue.length > 0) {
    const currentUrl = queue.shift();

    if (!currentUrl) continue;

    // Skip already visited URLs
    if (visited.has(currentUrl)) {
      continue;
    }

    visited.add(currentUrl);

    console.log("\nCrawling:", currentUrl);

    try {
      const response = await fetch(currentUrl);

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
          const absoluteUrl = new URL(href, currentUrl);

          // Only crawl the same domain
          if (
            absoluteUrl.hostname ===
            new URL(startUrl).hostname
          ) {
            const normalizedUrl = absoluteUrl.href;

            if (!visited.has(normalizedUrl)) {
              queue.push(normalizedUrl);
            }
          }
        } catch {
          // Ignore invalid URLs
        }
      });

    } catch (error) {
      console.log("Request failed:", currentUrl);
    }
  }
}

crawl();