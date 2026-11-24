import type { ErrorLog } from "./types.js";

export type ErrorCategory = "timeout" | "network" | "parse" | "4xx" | "5xx" | "other";

/**
 * Categorizes HTTP status codes into error types
 */
function categorizeStatusCode(statusCode: number): ErrorCategory {
    if (statusCode >= 400 && statusCode < 500) {
        return "4xx";
    }
    if (statusCode >= 500 && statusCode < 600) {
        return "5xx";
    }
    return "other";
}

/**
 * Categorizes errors from various sources
 */
export function categorizeError(error: unknown): ErrorCategory {
    if (!error) {
        return "other";
    }

    const errorMessage =
        error instanceof Error ? error.message : String(error).toLowerCase();

    if (
        errorMessage.includes("timeout") ||
        errorMessage.includes("timed out")
    ) {
        return "timeout";
    }
    if (
        errorMessage.includes("econnrefused") ||
        errorMessage.includes("enotfound") ||
        errorMessage.includes("network")
    ) {
        return "network";
    }
    if (
        errorMessage.includes("parse") ||
        errorMessage.includes("json") ||
        errorMessage.includes("xml")
    ) {
        return "parse";
    }

    return "other";
}

/**
 * Error tracker for collecting and categorizing crawl errors
 */
export class ErrorTracker {
    private errors: Map<string, ErrorLog> = new Map();
    private readonly maxErrors = 10_000; // Prevent unbounded memory growth

    /**
     * Records an error for a URL
     */
    recordError(
        url: string,
        error: unknown,
        statusCode?: number,
        isRetry = false
    ): void {
        // Determine error category
        let errorType: ErrorCategory;
        if (statusCode !== undefined) {
            errorType = categorizeStatusCode(statusCode);
        } else {
            errorType = categorizeError(error);
        }

        const message =
            error instanceof Error ? error.message : String(error);

        // Update existing error or create new one
        const existing = this.errors.get(url);
        if (existing) {
            existing.retriedCount++;
            existing.timestamp = Date.now();
            existing.message = message;
            existing.statusCode = statusCode;
            existing.errorType = errorType;
        } else {
            if (this.errors.size >= this.maxErrors) {
                // Remove oldest error to prevent memory exhaustion
                const firstKey = this.errors.keys().next().value;
                if (firstKey) {
                    this.errors.delete(firstKey);
                }
            }

            this.errors.set(url, {
                url,
                statusCode,
                errorType,
                message,
                timestamp: Date.now(),
                retriedCount: isRetry ? 1 : 0,
            });
        }
    }

    /**
     * Gets all recorded errors
     */
    getErrors(): ErrorLog[] {
        return Array.from(this.errors.values());
    }

    /**
     * Gets errors of a specific type
     */
    getErrorsByType(type: ErrorCategory): ErrorLog[] {
        return Array.from(this.errors.values()).filter((e) => e.errorType === type);
    }

    /**
     * Gets error statistics
     */
    getStats(): Record<ErrorCategory, number> {
        const stats: Record<ErrorCategory, number> = {
            timeout: 0,
            network: 0,
            parse: 0,
            "4xx": 0,
            "5xx": 0,
            other: 0,
        };

        for (const error of this.errors.values()) {
            stats[error.errorType]++;
        }

        return stats;
    }

    /**
     * Gets the most common errors
     */
    getTopErrors(limit = 10): ErrorLog[] {
        return Array.from(this.errors.values())
            .sort((a, b) => b.retriedCount - a.retriedCount)
            .slice(0, limit);
    }

    /**
     * Clears all errors
     */
    clear(): void {
        this.errors.clear();
    }

    /**
     * Gets total error count
     */
    get count(): number {
        return this.errors.size;
    }
}

/**
 * Determines if an error is retryable
 */
export function isRetryableError(error: unknown, statusCode?: number): boolean {
    // Retryable HTTP status codes
    if (statusCode !== undefined) {
        // 429 = Too Many Requests, 503 = Service Unavailable, 504 = Gateway Timeout
        return statusCode === 429 || statusCode === 503 || statusCode === 504;
    }

    const errorMessage =
        error instanceof Error ? error.message : String(error).toLowerCase();

    // Network errors are retryable
    if (
        errorMessage.includes("econnrefused") ||
        errorMessage.includes("enotfound") ||
        errorMessage.includes("econnreset") ||
        errorMessage.includes("etimedout")
    ) {
        return true;
    }

    // Timeout errors are retryable
    if (
        errorMessage.includes("timeout") ||
        errorMessage.includes("timed out")
    ) {
        return true;
    }

    return false;
}
