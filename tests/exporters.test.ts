import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportResults } from "../src/exporters/index.js";
import { serializeCsv } from "../src/exporters/csv.js";
import { serializeJson } from "../src/exporters/json.js";
import type { PageResult } from "../src/types.js";

const sampleResult: PageResult = {
    url: "https://example.com/page",
    title: 'Title, "quoted"\nsecond line',
    description: "first line\r\nsecond line",
    headings: ["One", "Two"],
    linksCount: 2,
};

describe("exporters", () => {
    let testDir: string | undefined;

    afterEach(async () => {
        if (testDir) {
            await rm(testDir, { recursive: true, force: true });
            testDir = undefined;
        }
    });

    it("serializes valid JSON, including empty results", () => {
        expect(JSON.parse(serializeJson([sampleResult]))).toEqual([sampleResult]);
        expect(serializeJson([])).toBe("[]");
    });

    it("escapes CSV commas, quotes, and embedded newlines", () => {
        const expected = [
            "url,title,description,headings,linksCount",
            'https://example.com/page,"Title, ""quoted""\nsecond line","first line\r\nsecond line","[""One"",""Two""]",2',
            "",
        ].join("\r\n");
        expect(serializeCsv([sampleResult])).toBe(expected);
    });

    it("emits a header for an empty CSV export and writes it to the requested file", async () => {
        testDir = await mkdtemp(join(tmpdir(), "crawler-csv-export-test-"));
        const outputPath = join(testDir, "empty.csv");

        await exportResults([], outputPath, "csv");

        await expect(readFile(outputPath, "utf8")).resolves.toBe(
            "url,title,description,headings,linksCount\r\n"
        );
    });

    it("reports the format and path when writing an export fails", async () => {
        testDir = await mkdtemp(join(tmpdir(), "crawler-export-error-test-"));
        const outputPath = join(testDir, "missing", "results.json");

        await expect(
            exportResults([], outputPath, "json")
        ).rejects.toThrow(`Failed to write JSON export to "${outputPath}"`);
    });
});
