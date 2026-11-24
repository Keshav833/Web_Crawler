import { describe, it, expect, beforeEach } from "vitest";
import {
    ErrorTracker,
    categorizeError,
    isRetryableError,
} from "../src/error-tracker.js";

describe("Error Tracker", () => {
    let tracker: ErrorTracker;

    beforeEach(() => {
        tracker = new ErrorTracker();
    });

    describe("recordError", () => {
        it("records errors", () => {
            const error = new Error("Test error");
            tracker.recordError("https://example.com/page", error);
            expect(tracker.count).toBe(1);
        });

        it("categorizes HTTP errors", () => {
            tracker.recordError("https://example.com/404", new Error("Not found"), 404);
            tracker.recordError("https://example.com/500", new Error("Server error"), 500);

            const errors = tracker.getErrors();
            expect(errors).toHaveLength(2);
            expect(errors[0]!.errorType).toBe("4xx");
            expect(errors[1]!.errorType).toBe("5xx");
        });

        it("tracks retry count", () => {
            tracker.recordError("https://example.com/page", new Error("Timeout"), undefined, false);
            tracker.recordError("https://example.com/page", new Error("Still timing out"), undefined, true);
            tracker.recordError("https://example.com/page", new Error("Still timing out"), undefined, true);

            const errors = tracker.getErrors();
            expect(errors).toHaveLength(1);
            expect(errors[0]!.retriedCount).toBe(2);
        });
    });

    describe("getErrors", () => {
        it("returns all recorded errors", () => {
            tracker.recordError("https://example.com/1", new Error("Error 1"));
            tracker.recordError("https://example.com/2", new Error("Error 2"));
            tracker.recordError("https://example.com/3", new Error("Error 3"));

            const errors = tracker.getErrors();
            expect(errors).toHaveLength(3);
        });
    });

    describe("getErrorsByType", () => {
        it("filters errors by type", () => {
            tracker.recordError("https://example.com/1", new Error("Timeout"));
            tracker.recordError("https://example.com/2", new Error("Connection refused"));
            tracker.recordError("https://example.com/3", new Error("Server error"), 503);

            const timeoutErrors = tracker.getErrorsByType("timeout");
            expect(timeoutErrors).toHaveLength(1);
            expect(timeoutErrors[0]!.url).toBe("https://example.com/1");
        });
    });

    describe("getStats", () => {
        it("returns error statistics", () => {
            tracker.recordError("https://example.com/1", new Error("Timeout"));
            tracker.recordError("https://example.com/2", new Error("Network error"));
            tracker.recordError("https://example.com/3", new Error("Server error"), 503);
            tracker.recordError("https://example.com/4", new Error("Parse error"));

            const stats = tracker.getStats();
            expect(stats.timeout).toBe(1);
            expect(stats.network).toBe(1);
            expect(stats["5xx"]).toBe(1);
            expect(stats.parse).toBe(1);
        });
    });

    describe("getTopErrors", () => {
        it("returns most retried errors", () => {
            tracker.recordError("https://example.com/1", new Error("Error 1"));
            tracker.recordError("https://example.com/1", new Error("Error 1"), undefined, true);
            tracker.recordError("https://example.com/1", new Error("Error 1"), undefined, true);

            tracker.recordError("https://example.com/2", new Error("Error 2"));
            tracker.recordError("https://example.com/2", new Error("Error 2"), undefined, true);

            const topErrors = tracker.getTopErrors(1);
            expect(topErrors).toHaveLength(1);
            expect(topErrors[0]!.url).toBe("https://example.com/1");
            expect(topErrors[0]!.retriedCount).toBe(2);
        });
    });

    describe("clear", () => {
        it("clears all errors", () => {
            tracker.recordError("https://example.com/1", new Error("Error 1"));
            tracker.recordError("https://example.com/2", new Error("Error 2"));
            expect(tracker.count).toBe(2);

            tracker.clear();
            expect(tracker.count).toBe(0);
            expect(tracker.getErrors()).toHaveLength(0);
        });
    });
});

describe("categorizeError", () => {
    it("categorizes timeout errors", () => {
        expect(categorizeError(new Error("timeout"))).toBe("timeout");
        expect(categorizeError(new Error("timed out"))).toBe("timeout");
    });

    it("categorizes network errors", () => {
        expect(categorizeError(new Error("ECONNREFUSED"))).toBe("network");
        expect(categorizeError(new Error("ENOTFOUND"))).toBe("network");
        expect(categorizeError(new Error("network error"))).toBe("network");
    });

    it("categorizes parse errors", () => {
        expect(categorizeError(new Error("parse error"))).toBe("parse");
        expect(categorizeError(new Error("JSON.parse failed"))).toBe("parse");
    });

    it("defaults to 'other' for unknown errors", () => {
        expect(categorizeError(new Error("unknown error"))).toBe("other");
        expect(categorizeError(undefined)).toBe("other");
    });
});

describe("isRetryableError", () => {
    it("identifies retryable HTTP status codes", () => {
        expect(isRetryableError(new Error("Any error"), 429)).toBe(true);
        expect(isRetryableError(new Error("Any error"), 503)).toBe(true);
        expect(isRetryableError(new Error("Any error"), 504)).toBe(true);
    });

    it("identifies non-retryable HTTP status codes", () => {
        expect(isRetryableError(new Error("Any error"), 404)).toBe(false);
        expect(isRetryableError(new Error("Any error"), 401)).toBe(false);
        expect(isRetryableError(new Error("Any error"), 200)).toBe(false);
    });

    it("identifies retryable network errors", () => {
        expect(isRetryableError(new Error("ECONNREFUSED"))).toBe(true);
        expect(isRetryableError(new Error("ENOTFOUND"))).toBe(true);
        expect(isRetryableError(new Error("ECONNRESET"))).toBe(true);
        expect(isRetryableError(new Error("ETIMEDOUT"))).toBe(true);
    });

    it("identifies retryable timeout errors", () => {
        expect(isRetryableError(new Error("timeout"))).toBe(true);
        expect(isRetryableError(new Error("timed out"))).toBe(true);
    });

    it("identifies non-retryable errors", () => {
        expect(isRetryableError(new Error("parse error"))).toBe(false);
        expect(isRetryableError(new Error("unknown error"))).toBe(false);
    });
});

