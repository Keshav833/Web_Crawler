import { describe, expect, it } from "vitest";
import {
    DEFAULT_CRAWLER_CONFIG,
    parseCliArgs,
    resolveCrawlerConfig,
} from "../src/config.js";

describe("CLI configuration", () => {
    it("uses documented defaults", () => {
        expect(parseCliArgs([])).toEqual({
            kind: "config",
            config: {
                ...DEFAULT_CRAWLER_CONFIG,
            },
        });
    });

    it("parses supported options in separate and equals forms", () => {
        expect(
            parseCliArgs([
                "--url=https://example.com/catalog",
                "--depth",
                "0",
                "--concurrency=4",
                "--delay",
                "250",
                "--max-pages=12",
                "--output",
                "out/crawl.json",
                "--format=json",
            ])
        ).toEqual({
            kind: "config",
            config: {
                startUrl: "https://example.com/catalog",
                maxDepth: 0,
                concurrency: 4,
                requestDelayMs: 250,
                maxPages: 12,
                outputPath: "out/crawl.json",
                format: "json",
                mode: "http",
                navigationTimeoutMs: 10_000,
            },
        });
    });

    it("parses browser mode and navigation timeout", () => {
        expect(
            parseCliArgs([
                "--mode=browser",
                "--concurrency",
                "2",
                "--navigation-timeout",
                "15000",
            ])
        ).toMatchObject({
            kind: "config",
            config: {
                mode: "browser",
                concurrency: 2,
                navigationTimeoutMs: 15_000,
            },
        });
    });

    it("displays help without requiring other arguments", () => {
        expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
        expect(parseCliArgs(["-h"])).toEqual({ kind: "help" });
    });

    it("accepts CSV as an export format", () => {
        expect(parseCliArgs(["--format", "csv"])).toMatchObject({
            kind: "config",
            config: { format: "csv" },
        });
    });

    it.each([
        ["invalid URL", ["--url", "not a URL"], /valid absolute URL/],
        ["non-HTTP URL", ["--url", "ftp://example.com/file"], /HTTP\(S\) URL/],
        ["URL credentials", ["--url", "https://user:pass@example.com/"], /without embedded credentials/],
        ["negative depth", ["--depth", "-1"], /whole number/],
        ["excessive depth", ["--depth", "11"], /between 0 and 10/],
        ["zero concurrency", ["--concurrency", "0"], /between 1 and 10/],
        ["excessive concurrency", ["--concurrency", "11"], /between 1 and 10/],
        ["short delay", ["--delay", "99"], /at least 100 milliseconds/],
        ["negative delay", ["--delay", "-1"], /whole number/],
        ["zero page limit", ["--max-pages", "0"], /between 1 and 10000/],
        ["excessive page limit", ["--max-pages", "10001"], /between 1 and 10000/],
        ["empty output path", ["--output", " "], /must not be empty/],
        ["unsupported format", ["--format", "yaml"], /must be json or csv/],
        ["unsupported mode", ["--mode", "stealth"], /must be http or browser/],
        ["too much browser concurrency", ["--mode", "browser", "--concurrency", "4"], /between 1 and 3 in browser mode/],
        ["invalid navigation timeout", ["--navigation-timeout", "0"], /between 1 and 120000/],
        ["unknown option", ["--verbose"], /Unknown option/],
        ["missing value", ["--url"], /requires a value/],
        ["duplicate option", ["--depth", "1", "--depth", "2"], /only be specified once/],
    ])("rejects %s", (_description, args, expectedError) => {
        expect(() => parseCliArgs(args)).toThrow(expectedError);
    });

    it("validates programmatic configuration using the same limits", () => {
        expect(() => resolveCrawlerConfig({ concurrency: 11 })).toThrow(
            "--concurrency must be between 1 and 10"
        );
    });
});
