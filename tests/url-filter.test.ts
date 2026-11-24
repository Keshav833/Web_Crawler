import { describe, it, expect } from "vitest";
import {
    UrlFilter,
    isLikelyFile,
    isLikelyTrackingUrl,
    URL_FILTER_PRESETS,
} from "../src/url-filter.js";

describe("UrlFilter", () => {
    describe("shouldInclude", () => {
        it("includes all URLs when no filters configured", () => {
            const filter = new UrlFilter();
            expect(filter.shouldInclude("https://example.com/page1")).toBe(true);
            expect(filter.shouldInclude("https://example.com/admin")).toBe(true);
            expect(filter.shouldInclude("https://example.com/api")).toBe(true);
        });

        it("includes only URLs matching include patterns", () => {
            const filter = new UrlFilter({
                includePatterns: ["^/products/", "^/items/"],
            });
            expect(filter.shouldInclude("/products/123")).toBe(true);
            expect(filter.shouldInclude("/items/456")).toBe(true);
            expect(filter.shouldInclude("/pages/about")).toBe(false);
            expect(filter.shouldInclude("/admin/users")).toBe(false);
        });

        it("excludes URLs matching exclude patterns", () => {
            const filter = new UrlFilter({
                excludePatterns: ["^/admin", "^/api", "\\.pdf$"],
            });
            expect(filter.shouldInclude("/products/page")).toBe(true);
            expect(filter.shouldInclude("/admin/users")).toBe(false);
            expect(filter.shouldInclude("/api/endpoint")).toBe(false);
            expect(filter.shouldInclude("/document.pdf")).toBe(false);
        });

        it("applies both include and exclude patterns", () => {
            const filter = new UrlFilter({
                includePatterns: ["^/products/"],
                excludePatterns: ["restricted"],
            });
            expect(filter.shouldInclude("/products/item1")).toBe(true);
            expect(filter.shouldInclude("/products/restricted-item")).toBe(false);
            expect(filter.shouldInclude("/pages/products")).toBe(false);
        });
    });

    describe("filter", () => {
        it("filters a list of URLs", () => {
            const filter = new UrlFilter({
                excludePatterns: ["^/admin"],
            });
            const urls = [
                "/products/1",
                "/admin/dashboard",
                "/products/2",
                "/admin/users",
                "/about",
            ];
            const filtered = filter.filter(urls);
            expect(filtered).toEqual([
                "/products/1",
                "/products/2",
                "/about",
            ]);
        });
    });

    describe("addIncludePattern", () => {
        it("adds include patterns dynamically", () => {
            const filter = new UrlFilter();
            filter.addIncludePattern("^/products/");
            filter.addIncludePattern("^/services/");

            expect(filter.shouldInclude("/products/123")).toBe(true);
            expect(filter.shouldInclude("/services/abc")).toBe(true);
            expect(filter.shouldInclude("/about")).toBe(false);
        });

        it("throws on invalid regex", () => {
            const filter = new UrlFilter();
            expect(() => filter.addIncludePattern("(?P<invalid>)")).toThrow();
        });
    });

    describe("addExcludePattern", () => {
        it("adds exclude patterns dynamically", () => {
            const filter = new UrlFilter();
            filter.addExcludePattern("^/admin");
            filter.addExcludePattern("\\.pdf$");

            expect(filter.shouldInclude("/admin/page")).toBe(false);
            expect(filter.shouldInclude("/document.pdf")).toBe(false);
            expect(filter.shouldInclude("/pages/about")).toBe(true);
        });

        it("throws on invalid regex", () => {
            const filter = new UrlFilter();
            expect(() => filter.addExcludePattern("(?P<invalid>)")).toThrow();
        });
    });
});

describe("isLikelyFile", () => {
    it("identifies document files", () => {
        expect(isLikelyFile("document.pdf")).toBe(true);
        expect(isLikelyFile("spreadsheet.xlsx")).toBe(true);
        expect(isLikelyFile("presentation.pptx")).toBe(true);
    });

    it("identifies archive files", () => {
        expect(isLikelyFile("archive.zip")).toBe(true);
        expect(isLikelyFile("files.rar")).toBe(true);
        expect(isLikelyFile("compressed.7z")).toBe(true);
    });

    it("identifies media files", () => {
        expect(isLikelyFile("video.mp4")).toBe(true);
        expect(isLikelyFile("audio.mp3")).toBe(true);
        expect(isLikelyFile("image.jpg")).toBe(true);
    });

    it("identifies code/data files", () => {
        expect(isLikelyFile("script.js")).toBe(true);
        expect(isLikelyFile("stylesheet.css")).toBe(true);
        expect(isLikelyFile("data.json")).toBe(true);
    });

    it("does not identify pages as files", () => {
        expect(isLikelyFile("/products/item1")).toBe(false);
        expect(isLikelyFile("/about-us")).toBe(false);
        expect(isLikelyFile("/blog/post-title")).toBe(false);
    });

    it("is case insensitive", () => {
        expect(isLikelyFile("Document.PDF")).toBe(true);
        expect(isLikelyFile("ARCHIVE.ZIP")).toBe(true);
        expect(isLikelyFile("IMAGE.JPG")).toBe(true);
    });
});

describe("isLikelyTrackingUrl", () => {
    it("identifies UTM tracking parameters", () => {
        expect(
            isLikelyTrackingUrl("https://example.com/page?utm_source=google")
        ).toBe(true);
        expect(
            isLikelyTrackingUrl("https://example.com/page?utm_campaign=sale")
        ).toBe(true);
    });

    it("identifies Facebook and Google tracking parameters", () => {
        expect(
            isLikelyTrackingUrl("https://example.com/page?fbclid=12345")
        ).toBe(true);
        expect(
            isLikelyTrackingUrl("https://example.com/page?gclid=12345")
        ).toBe(true);
    });

    it("identifies pagination patterns", () => {
        expect(isLikelyTrackingUrl("/products/page/2")).toBe(true);
        expect(isLikelyTrackingUrl("/items?page=3")).toBe(true);
    });

    it("identifies sorting and filtering", () => {
        expect(isLikelyTrackingUrl("/products?sort=price")).toBe(true);
        expect(isLikelyTrackingUrl("/items?filter=category")).toBe(true);
    });

    it("identifies redirect parameters", () => {
        expect(
            isLikelyTrackingUrl(
                "https://example.com/page?redirect=/target"
            )
        ).toBe(true);
    });

    it("does not identify clean URLs", () => {
        expect(isLikelyTrackingUrl("/about-us")).toBe(false);
        expect(isLikelyTrackingUrl("/products/item-1")).toBe(false);
    });
});

describe("URL_FILTER_PRESETS", () => {
    it("provides productsOnly preset", () => {
        const filter = new UrlFilter(URL_FILTER_PRESETS.productsOnly);
        expect(filter.shouldInclude("/product/123")).toBe(true);
        expect(filter.shouldInclude("/item/456")).toBe(true);
        expect(filter.shouldInclude("/about")).toBe(false);
    });

    it("provides noAdmin preset", () => {
        const filter = new UrlFilter(URL_FILTER_PRESETS.noAdmin);
        expect(filter.shouldInclude("/about")).toBe(true);
        expect(filter.shouldInclude("/admin/users")).toBe(false);
        expect(filter.shouldInclude("/dashboard")).toBe(false);
    });

    it("provides noMedia preset", () => {
        const filter = new UrlFilter(URL_FILTER_PRESETS.noMedia);
        expect(filter.shouldInclude("/about")).toBe(true);
        expect(filter.shouldInclude("/document.pdf")).toBe(false);
        expect(filter.shouldInclude("/image.jpg")).toBe(false);
    });
});
