import { describe, it, expect } from "vitest";
import {
    extractStructuredData,
    extractCustomFields,
} from "../src/structured-data-extractor.js";

describe("Structured Data Extractor", () => {
    describe("extractStructuredData", () => {
        it("extracts JSON-LD", () => {
            const html = `
        <html>
        <head>
            <script type="application/ld+json">
            {"@type": "Article", "headline": "Test Article", "author": "John Doe"}
            </script>
        </head>
        </html>
      `;
            const result = extractStructuredData(html);
            expect(result.jsonLd).toBeDefined();
            expect(result.jsonLd).toHaveLength(1);
            expect(result.jsonLd?.[0]).toEqual({
                "@type": "Article",
                headline: "Test Article",
                author: "John Doe",
            });
        });

        it("extracts OpenGraph meta tags", () => {
            const html = `
        <html>
        <head>
            <meta property="og:title" content="Test Title">
            <meta property="og:description" content="Test Description">
            <meta property="og:image" content="https://example.com/image.jpg">
        </head>
        </html>
      `;
            const result = extractStructuredData(html);
            expect(result.openGraph).toBeDefined();
            expect(result.openGraph).toEqual({
                "og:title": "Test Title",
                "og:description": "Test Description",
                "og:image": "https://example.com/image.jpg",
            });
        });

        it("extracts Schema.org microdata", () => {
            const html = `
        <html>
        <body>
            <div itemtype="https://schema.org/Product">
                <span itemprop="name">Test Product</span>
                <span itemprop="price">$9.99</span>
                <span itemprop="rating">4.5</span>
            </div>
        </body>
        </html>
      `;
            const result = extractStructuredData(html);
            expect(result.schema).toBeDefined();
            expect(result.schema).toHaveLength(1);
            expect(result.schema?.[0]).toMatchObject({
                "@type": "https://schema.org/Product",
                name: "Test Product",
                price: "$9.99",
                rating: "4.5",
            });
        });

        it("handles missing structured data", () => {
            const html = "<html><body><h1>No structured data</h1></body></html>";
            const result = extractStructuredData(html);
            expect(Object.keys(result)).toHaveLength(0);
        });

        it("handles multiple JSON-LD scripts", () => {
            const html = `
        <html>
        <head>
            <script type="application/ld+json">{"@type": "WebSite", "url": "https://example.com"}</script>
            <script type="application/ld+json">{"@type": "Organization", "name": "Example"}</script>
        </head>
        </html>
      `;
            const result = extractStructuredData(html);
            expect(result.jsonLd).toHaveLength(2);
        });

        it("skips invalid JSON-LD", () => {
            const html = `
        <html>
        <head>
            <script type="application/ld+json">{"invalid json}</script>
            <script type="application/ld+json">{"@type": "Valid", "test": true}</script>
        </head>
        </html>
      `;
            const result = extractStructuredData(html);
            expect(result.jsonLd).toHaveLength(1);
            expect(result.jsonLd?.[0]).toEqual({
                "@type": "Valid",
                test: true,
            });
        });
    });

    describe("extractCustomFields", () => {
        it("extracts single text values", () => {
            const html = `
        <html>
        <body>
            <h1 class="title">Product Title</h1>
            <span class="price">$19.99</span>
        </body>
        </html>
      `;
            const result = extractCustomFields(html, {
                title: "h1.title",
                price: ".price",
            });
            expect(result).toEqual({
                title: "Product Title",
                price: "$19.99",
            });
        });

        it("extracts multiple values as array", () => {
            const html = `
        <html>
        <body>
            <div class="items">
                <span class="item">Item 1</span>
                <span class="item">Item 2</span>
                <span class="item">Item 3</span>
            </div>
        </body>
        </html>
      `;
            const result = extractCustomFields(html, {
                items: ".item",
            });
            expect(result.items).toEqual(["Item 1", "Item 2", "Item 3"]);
        });

        it("returns null for non-existent selectors", () => {
            const html = "<html><body></body></html>";
            const result = extractCustomFields(html, {
                missing: ".does-not-exist",
            });
            expect(result.missing).toBeNull();
        });

        it("handles invalid CSS selectors gracefully", () => {
            const html = "<html><body><h1>Test</h1></body></html>";
            const result = extractCustomFields(html, {
                valid: "h1",
                invalid: ":::invalid:::selector",
            });
            expect(result.valid).toBe("Test");
            expect(result.invalid).toBeNull();
        });

        it("filters empty text values", () => {
            const html = `
        <html>
        <body>
            <div class="items">
                <span class="item">Item 1</span>
                <span class="item"></span>
                <span class="item">Item 2</span>
            </div>
        </body>
        </html>
      `;
            const result = extractCustomFields(html, {
                items: ".item",
            });
            expect(result.items).toEqual(["Item 1", "Item 2"]);
        });
    });
});
