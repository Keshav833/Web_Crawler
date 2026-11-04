import * as cheerio from "cheerio";
import type { PageResult } from "./types.js";

export type ParsedPage = {
    result: PageResult;
    links: string[];
};

export function parsePage(html: string, url: string): ParsedPage {
    const $ = cheerio.load(html);
    const links = $("a")
        .map((_, element) => $(element).attr("href"))
        .get()
        .filter((href): href is string => Boolean(href));

    return {
        result: {
            url,
            title: $("title").text().trim(),
            description:
                $('meta[name="description"]').attr("content")?.trim() ?? "",
            headings: $("h1, h2, h3")
                .map((_, element) => $(element).text().trim())
                .get()
                .filter(Boolean),
            linksCount: $("a[href]").length,
        },
        links,
    };
}
