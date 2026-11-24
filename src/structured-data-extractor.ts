import * as cheerio from "cheerio";
import type { StructuredData } from "./types.js";

/**
 * Extracts structured data from HTML including:
 * - JSON-LD scripts
 * - OpenGraph meta tags
 * - Schema.org microdata
 */
export function extractStructuredData(html: string): StructuredData {
    const $ = cheerio.load(html);
    const result: StructuredData = {};

    // Extract JSON-LD
    const jsonLdScripts = $("script[type='application/ld+json']");
    if (jsonLdScripts.length > 0) {
        const jsonLdArray: Record<string, unknown>[] = [];
        jsonLdScripts.each((_, elem) => {
            try {
                const content = $(elem).html();
                if (content) {
                    const parsed = JSON.parse(content);
                    jsonLdArray.push(parsed);
                }
            } catch {
                // Silently skip invalid JSON-LD
            }
        });
        if (jsonLdArray.length > 0) {
            result.jsonLd = jsonLdArray;
        }
    }

    // Extract OpenGraph meta tags
    const ogTags = $("meta[property^='og:']");
    if (ogTags.length > 0) {
        const openGraph: Record<string, string> = {};
        ogTags.each((_, elem) => {
            const property = $(elem).attr("property");
            const content = $(elem).attr("content");
            if (property && content) {
                openGraph[property] = content;
            }
        });
        if (Object.keys(openGraph).length > 0) {
            result.openGraph = openGraph;
        }
    }

    // Extract Schema.org microdata (basic support)
    const schemaElements = $("[itemtype]");
    if (schemaElements.length > 0) {
        const schemaArray: Record<string, unknown>[] = [];
        schemaElements.each((_, elem) => {
            const itemType = $(elem).attr("itemtype");
            const schema: Record<string, unknown> = { "@type": itemType };

            // Extract itemprops
            $(elem)
                .find("[itemprop]")
                .each((__, propElem) => {
                    const propName = $(propElem).attr("itemprop");
                    let propValue: string | undefined;

                    if (propElem.name === "meta") {
                        propValue = $(propElem).attr("content");
                    } else if (propElem.name === "a") {
                        propValue = $(propElem).attr("href");
                    } else if (propElem.name === "img") {
                        propValue = $(propElem).attr("src");
                    } else {
                        propValue = $(propElem).text().trim();
                    }

                    if (propName && propValue) {
                        if (schema[propName]) {
                            // Convert to array if multiple values
                            if (Array.isArray(schema[propName])) {
                                (schema[propName] as string[]).push(propValue);
                            } else {
                                schema[propName] = [schema[propName], propValue];
                            }
                        } else {
                            schema[propName] = propValue;
                        }
                    }
                });

            schemaArray.push(schema);
        });
        if (schemaArray.length > 0) {
            result.schema = schemaArray;
        }
    }

    return result;
}

/**
 * Extract custom fields using CSS selectors
 * @param html - HTML content
 * @param selectors - Map of field names to CSS selectors
 * @returns Extracted custom fields
 */
export function extractCustomFields(
    html: string,
    selectors: Record<string, string>
): Record<string, unknown> {
    const $ = cheerio.load(html);
    const result: Record<string, unknown> = {};

    for (const [fieldName, selector] of Object.entries(selectors)) {
        try {
            const elements = $(selector);
            if (elements.length === 0) {
                result[fieldName] = null;
            } else if (elements.length === 1) {
                // Single element: return text content
                result[fieldName] = $(elements[0]).text().trim();
            } else {
                // Multiple elements: return array
                result[fieldName] = elements
                    .map((_, elem) => $(elem).text().trim())
                    .get()
                    .filter(Boolean);
            }
        } catch (error) {
            // Invalid selector - set null
            result[fieldName] = null;
        }
    }

    return result;
}
