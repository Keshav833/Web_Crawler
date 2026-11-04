import type { PageResult } from "../types.js";

const COLUMNS = ["url", "title", "description", "headings", "linksCount"];

function escapeCsvCell(value: string | number): string {
    const text = String(value);
    if (/[",\r\n]/.test(text)) {
        return `"${text.replaceAll('"', '""')}"`;
    }
    return text;
}

export function serializeCsv(results: PageResult[]): string {
    const header = COLUMNS.join(",");
    const rows = results.map((result) =>
        [
            result.url,
            result.title,
            result.description,
            JSON.stringify(result.headings),
            result.linksCount,
        ]
            .map(escapeCsvCell)
            .join(",")
    );

    return `${[header, ...rows].join("\r\n")}\r\n`;
}
