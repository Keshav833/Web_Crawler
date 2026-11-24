import { fetch, type RequestInfo, type RequestInit } from "node:fetch";
import * as zlib from "node:zlib";

type SitemapEntry = {
    url: string;
    lastmod?: string;
    changefreq?: string;
    priority?: number;
};

/**
 * Attempts to discover and fetch sitemaps for a given origin
 * @param origin - The website origin (e.g., https://example.com)
 * @returns List of discovered URLs from sitemaps, or empty array if none found
 */
export async function discoverSitemapUrls(origin: string): Promise<string[]> {
    const urls = new Set<string>();

    // Try common sitemap locations
    const sitemapLocations = [
        `${origin}/sitemap.xml`,
        `${origin}/sitemap_index.xml`,
        `${origin}/sitemap-index.xml`,
        `${origin}/robots.txt`, // Will parse for sitemaps
    ];

    for (const location of sitemapLocations) {
        try {
            const foundUrls = await fetchSitemapUrls(location);
            foundUrls.forEach((url) => urls.add(url));
        } catch {
            // Continue to next location
        }
    }

    return Array.from(urls);
}

/**
 * Fetches a single sitemap and extracts URLs
 * Handles both sitemap.xml and sitemap_index.xml
 * @param sitemapUrl - URL to the sitemap or sitemap index
 * @returns List of URLs from the sitemap
 */
async function fetchSitemapUrls(sitemapUrl: string): Promise<string[]> {
    try {
        const response = await fetchWithAutoDecompress(sitemapUrl);
        if (!response.ok) {
            return [];
        }

        const contentType = response.headers.get("content-type") ?? "";
        const isXml = contentType.includes("xml");

        if (!isXml && sitemapUrl.includes("robots.txt")) {
            // Parse robots.txt for sitemap directives
            const text = await response.text();
            return parseSitemapsFromRobotsTxt(text);
        }

        const xml = await response.text();
        return parseSitemapXml(xml);
    } catch {
        return [];
    }
}

/**
 * Fetches a URL and automatically decompresses gzip if needed
 */
async function fetchWithAutoDecompress(
    url: string,
    options: RequestInit = {}
): Promise<Response> {
    const response = await fetch(url as RequestInfo, {
        ...options,
        headers: {
            "Accept-Encoding": "gzip, deflate",
            ...options.headers,
        },
        timeout: 10_000,
    });

    if (!response.ok) {
        return response;
    }

    const contentEncoding = response.headers.get("content-encoding");
    if (contentEncoding === "gzip" && response.body) {
        const buffer = Buffer.from(await response.arrayBuffer());
        const decompressed = await new Promise<Buffer>((resolve, reject) => {
            zlib.gunzip(buffer, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });
        // Create a new Response-like object with decompressed content
        return new Response(decompressed, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    }

    return response;
}

/**
 * Parses a sitemap XML and extracts URLs
 * Handles both urlset (regular sitemap) and sitemapindex
 */
function parseSitemapXml(xml: string): string[] {
    const urls: string[] = [];

    try {
        // Extract URLs from <url> tags (regular sitemap)
        const urlPattern = /<url>\s*<loc>(.*?)<\/loc>/gs;
        let match;
        while ((match = urlPattern.exec(xml)) !== null) {
            const url = match[1].trim();
            if (url) {
                urls.push(url);
            }
        }

        // Extract sitemap URLs from <sitemap> tags (sitemap index)
        const sitemapPattern = /<sitemap>\s*<loc>(.*?)<\/loc>/gs;
        while ((match = sitemapPattern.exec(xml)) !== null) {
            const sitemapUrl = match[1].trim();
            if (sitemapUrl) {
                // Recursively fetch nested sitemaps (but limit depth to prevent loops)
                // This would be handled by the caller in a queue-based approach
                urls.push(sitemapUrl);
            }
        }
    } catch {
        // Invalid XML - return empty
    }

    return urls;
}

/**
 * Parses robots.txt for Sitemap directives
 */
function parseSitemapsFromRobotsTxt(robotsTxt: string): string[] {
    const urls: string[] = [];
    const lines = robotsTxt.split(/\r?\n/);

    for (const line of lines) {
        const trimmed = line.trim().toLowerCase();
        if (trimmed.startsWith("sitemap:")) {
            const url = line.substring(8).trim();
            if (url) {
                urls.push(url);
            }
        }
    }

    return urls;
}

/**
 * Fetches and parses a robots.txt Sitemap directive
 * Returns the sitemap URLs
 */
export async function parseSitemapDirective(
    origin: string,
    robotsTxtContent?: string
): Promise<string[]> {
    const urls: string[] = [];

    if (robotsTxtContent) {
        return parseSitemapsFromRobotsTxt(robotsTxtContent);
    }

    try {
        const response = await fetch(`${origin}/robots.txt`);
        if (response.ok) {
            const text = await response.text();
            return parseSitemapsFromRobotsTxt(text);
        }
    } catch {
        // robots.txt not found or unreachable
    }

    return urls;
}

/**
 * Recursively fetches all URLs from a sitemap or sitemap index
 * Respects depth limit to prevent infinite loops
 */
export async function fetchAllSitemapUrls(
    startSitemapUrl: string,
    maxDepth = 3
): Promise<string[]> {
    const allUrls = new Set<string>();
    const visited = new Set<string>();
    const queue: { url: string; depth: number }[] = [
        { url: startSitemapUrl, depth: 0 },
    ];

    while (queue.length > 0) {
        const { url, depth } = queue.shift()!;

        if (visited.has(url) || depth > maxDepth) {
            continue;
        }

        visited.add(url);

        try {
            const urls = await fetchSitemapUrls(url);
            for (const fetchedUrl of urls) {
                // If it looks like a sitemap, add to queue; otherwise add to results
                if (
                    fetchedUrl.includes("sitemap") &&
                    (fetchedUrl.endsWith(".xml") || fetchedUrl.includes(".xml"))
                ) {
                    queue.push({ url: fetchedUrl, depth: depth + 1 });
                } else {
                    allUrls.add(fetchedUrl);
                }
            }
        } catch {
            // Skip this URL and continue
        }
    }

    return Array.from(allUrls);
}
