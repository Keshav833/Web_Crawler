import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPage, HttpError, USER_AGENT } from "../src/fetcher.js";

const pageUrl = "https://example.com/page";

function htmlResponse(): Response {
    return new Response("<html>page</html>", {
        status: 200,
        headers: {
            "content-type": "text/html; charset=utf-8",
        },
    });
}

beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("fetchPage", () => {
    it("returns an HTML response body and sends the crawler user-agent", async () => {
        const fetchMock = vi.fn(async () => htmlResponse());
        vi.stubGlobal("fetch", fetchMock);

        await expect(
            fetchPage(pageUrl, { requestDelayMs: 0 })
        ).resolves.toBe("<html>page</html>");
        expect(fetchMock).toHaveBeenCalledWith(
            pageUrl,
            expect.objectContaining({
                headers: { "user-agent": USER_AGENT },
            })
        );
    });

    it("does not retry a non-retryable HTTP error", async () => {
        const fetchMock = vi.fn(async () => new Response("Not found", { status: 404 }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(
            fetchPage(pageUrl, { requestDelayMs: 0 })
        ).rejects.toBeInstanceOf(HttpError);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("follows redirects only within the configured HTTPS host policy", async () => {
        const redirectUrl = "https://example.com/next";
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 302,
                    headers: { location: redirectUrl },
                })
            )
            .mockResolvedValueOnce(htmlResponse());
        vi.stubGlobal("fetch", fetchMock);

        await expect(
            fetchPage(pageUrl, {
                requestDelayMs: 0,
                allowedRedirectHosts: ["example.com"],
            })
        ).resolves.toBe("<html>page</html>");
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            expect.any(URL),
            expect.objectContaining({ redirect: "manual" })
        );
    });

    it("blocks redirects to hosts outside the public crawl policy", async () => {
        const fetchMock = vi.fn(async () =>
            new Response(null, {
                status: 302,
                headers: { location: "http://127.0.0.1:8080/private" },
            })
        );
        vi.stubGlobal("fetch", fetchMock);

        await expect(
            fetchPage(pageUrl, {
                maxAttempts: 1,
                requestDelayMs: 0,
                allowedRedirectHosts: ["example.com"],
            })
        ).rejects.toThrow("outside the configured crawl host policy");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("stops reading an HTML response that exceeds the configured size limit", async () => {
        const fetchMock = vi.fn(async () =>
            new Response("<html>oversized</html>", {
                headers: { "content-type": "text/html" },
            })
        );
        vi.stubGlobal("fetch", fetchMock);

        await expect(
            fetchPage(pageUrl, {
                maxAttempts: 1,
                requestDelayMs: 0,
                maxResponseBytes: 10,
            })
        ).rejects.toThrow("Response exceeds the 10-byte limit");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([429, 503])("retries HTTP %s and succeeds on the next attempt", async (status) => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(new Response("retry", { status }))
            .mockResolvedValueOnce(htmlResponse());
        vi.stubGlobal("fetch", fetchMock);

        await expect(
            fetchPage(pageUrl, { maxAttempts: 2, requestDelayMs: 0 })
        ).resolves.toBe("<html>page</html>");
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("retries a network failure", async () => {
        const fetchMock = vi
            .fn()
            .mockRejectedValueOnce(new TypeError("network failure"))
            .mockResolvedValueOnce(htmlResponse());
        vi.stubGlobal("fetch", fetchMock);

        await expect(
            fetchPage(pageUrl, { maxAttempts: 2, requestDelayMs: 0 })
        ).resolves.toBe("<html>page</html>");
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("rejects after exhausting retryable HTTP failures", async () => {
        const fetchMock = vi.fn(async () => new Response("Unavailable", { status: 503 }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(
            fetchPage(pageUrl, { requestDelayMs: 0 })
        ).rejects.toBeInstanceOf(HttpError);
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("aborts a request when its timeout expires", async () => {
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

        const request = fetchPage(pageUrl, {
            maxAttempts: 1,
            timeoutMs: 20,
            requestDelayMs: 0,
        });
        const requestExpectation = expect(request).rejects.toThrow("Aborted");
        await started;
        await vi.advanceTimersByTimeAsync(20);

        await requestExpectation;
        expect(requestSignal?.aborted).toBe(true);
    });

    it.each([
        ["PDF", "application/pdf"],
        ["missing", null],
    ])("returns null for %s content type", async (_label, contentType) => {
        const response = contentType
            ? new Response("not HTML", {
                  status: 200,
                  headers: { "content-type": contentType },
              })
            : new Response("not HTML", { status: 200 });
        const fetchMock = vi.fn(async () => response);
        vi.stubGlobal("fetch", fetchMock);

        await expect(
            fetchPage(pageUrl, { requestDelayMs: 0 })
        ).resolves.toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
