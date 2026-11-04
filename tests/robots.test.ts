import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, USER_AGENT } from "../src/fetcher.js";
import { getRobotsParser } from "../src/robots.js";

const startUrl = "https://example.com/catalog/";

beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("getRobotsParser", () => {
    it("applies allowed and disallowed rules for the crawler user-agent", async () => {
        const robotsText = [
            `User-agent: ${USER_AGENT}`,
            "Disallow: /private",
            "",
        ].join("\n");
        const fetchMock = vi.fn(
            async () =>
                new Response(robotsText, {
                    status: 200,
                    headers: { "content-type": "text/plain" },
                })
        );
        vi.stubGlobal("fetch", fetchMock);

        const policy = await getRobotsParser(startUrl);

        expect(policy?.isAllowed("https://example.com/public", USER_AGENT)).toBe(true);
        expect(policy?.isAllowed("https://example.com/private", USER_AGENT)).toBe(false);
        expect(fetchMock).toHaveBeenCalledWith(
            "https://example.com/robots.txt",
            expect.objectContaining({
                headers: { "user-agent": USER_AGENT },
            })
        );
    });

    it("returns null when robots.txt is missing", async () => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(getRobotsParser(startUrl)).resolves.toBeNull();
    });

    it("reports network failures clearly", async () => {
        const fetchMock = vi.fn().mockRejectedValue(new TypeError("connection refused"));
        vi.stubGlobal("fetch", fetchMock);

        await expect(getRobotsParser(startUrl)).rejects.toThrow(
            "Network error fetching robots.txt: connection refused"
        );
    });

    it("preserves HTTP errors when robots.txt cannot be retrieved", async () => {
        const fetchMock = vi.fn(async () => new Response("Unavailable", { status: 503 }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(getRobotsParser(startUrl)).rejects.toBeInstanceOf(HttpError);
    });

    it("aborts robots.txt retrieval when its timeout expires", async () => {
        vi.useFakeTimers();
        let markStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        let requestSignal: AbortSignal | undefined;
        const fetchMock = vi.fn(
            (_input: RequestInfo | URL, init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    requestSignal = init?.signal ?? undefined;
                    markStarted();
                    requestSignal?.addEventListener(
                        "abort",
                        () => reject(new DOMException("Aborted", "AbortError")),
                        { once: true }
                    );
                })
        );
        vi.stubGlobal("fetch", fetchMock);

        const request = getRobotsParser(startUrl, 20);
        const requestExpectation = expect(request).rejects.toThrow(
            "Timed out while fetching robots.txt after 20ms"
        );
        await started;
        await vi.advanceTimersByTimeAsync(20);

        await requestExpectation;
        expect(requestSignal?.aborted).toBe(true);
    });
});
