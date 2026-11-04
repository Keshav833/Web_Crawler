import { describe, expect, it } from "vitest";
import { parsePage } from "../src/parser.js";

describe("parsePage", () => {
    it("extracts page metadata, headings, link count, and link hrefs", () => {
        expect(
            parsePage(
                [
                    "<html><head>",
                    "<title> Example page </title>",
                    '<meta name="description" content=" A description ">',
                    "</head><body>",
                    "<h1> Main heading </h1><h2>Section</h2><h3>   </h3>",
                    '<a href="/one">one</a><a href="/two">two</a><a>missing href</a>',
                    "</body></html>",
                ].join(""),
                "https://example.com/current"
            )
        ).toEqual({
            result: {
                url: "https://example.com/current",
                title: "Example page",
                description: "A description",
                headings: ["Main heading", "Section"],
                linksCount: 2,
            },
            links: ["/one", "/two"],
        });
    });
});
