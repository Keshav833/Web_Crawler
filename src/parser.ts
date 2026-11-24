import * as cheerio from "cheerio";
import type { ExtractionConfig, PageResult } from "./types.js";
import {
    extractStructuredData,
    extractCustomFields,
} from "./structured-data-extractor.js";

export type ParsedPage = {
    result: PageResult;
    links: string[];
};

export function parsePage(
    html: string,
    url: string,
    config?: ExtractionConfig
): ParsedPage {
    const $ = cheerio.load(html);
    const links = $("a")
        .map((_, element) => $(element).attr("href"))
        .get()
        .filter((href): href is string => Boolean(href));

    const result: PageResult = {
        url,
        title: $("title").text().trim(),
        description:
            $('meta[name="description"]').attr("content")?.trim() ?? "",
        headings: $("h1, h2, h3")
            .map((_, element) => $(element).text().trim())
            .get()
            .filter(Boolean),
        linksCount: $("a[href]").length,
        crawledAt: Date.now(),
    };

    // Extract structured data if requested
    if (config?.includeStructuredData) {
        result.structuredData = extractStructuredData(html);
    }

    // Extract custom fields if specified
    if (config?.customSelectors) {
        result.customFields = extractCustomFields(html, config.customSelectors);
    }

    return {
        result,
        links,
    };
}
