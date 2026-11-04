import { writeFile } from "node:fs/promises";
import { serializeCsv } from "./csv.js";
import { serializeJson } from "./json.js";
import type { PageResult } from "../types.js";

export type ExportFormat = "json" | "csv";

export async function exportResults(
    results: PageResult[],
    outputPath: string,
    format: ExportFormat
): Promise<void> {
    const contents =
        format === "json" ? serializeJson(results) : serializeCsv(results);

    try {
        await writeFile(outputPath, contents, "utf-8");
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Failed to write ${format.toUpperCase()} export to "${outputPath}": ${detail}`,
            { cause: error }
        );
    }
}
