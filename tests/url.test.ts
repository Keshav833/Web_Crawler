import { describe, expect, it } from "vitest";
import { normalizeUrl } from "../src/url.js";

describe("normalizeUrl", () => {
    it("resolves relative URLs and removes fragments and tracking parameters", () => {
        expect(
            normalizeUrl(
                "../chapter.html?utm_source=newsletter&ref=home#overview",
                "https://example.com/books/index.html"
            )
        ).toBe("https://example.com/chapter.html?ref=home");
    });

    it.each([
        ["HTTP", "http://example.com/page"],
        ["HTTPS", "https://example.com/page"],
    ])("accepts absolute %s URLs", (_protocol, input) => {
        expect(normalizeUrl(input, "https://base.example/")).toBe(input);
    });

    it.each([
        ["malformed", "http://[invalid"],
        ["mailto", "mailto:user@example.com"],
        ["javascript", "javascript:alert(1)"],
    ])("rejects %s URLs", (_kind, input) => {
        expect(normalizeUrl(input, "https://example.com/")).toBeNull();
    });

    it.each(["xml", "pdf", "png", "js"])(
        "rejects unsupported .%s resources",
        (extension) => {
            expect(
                normalizeUrl(
                    `https://example.com/resource.${extension}`,
                    "https://example.com/"
                )
            ).toBeNull();
        }
    );

    it("accepts .php routes and preserves ordinary query parameters", () => {
        expect(
            normalizeUrl(
                "https://example.com/catalog.php?id=42&sort=title",
                "https://base.example/"
            )
        ).toBe("https://example.com/catalog.php?id=42&sort=title");
    });

    it("does not apply the crawler's same-domain restriction", () => {
        expect(
            normalizeUrl(
                "https://other.example/page",
                "https://example.com/"
            )
        ).toBe("https://other.example/page");
    });
});
