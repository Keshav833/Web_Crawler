export const USER_AGENT = "MyCrawler/1.0";

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT = 5000;
const REQUEST_DELAY = 1000;

export type FetchPageOptions = {
    maxAttempts?: number;
    timeoutMs?: number;
    requestDelayMs?: number;
};

export type ResolvedFetchPageOptions = Required<FetchPageOptions>;

let lastRequestTime = 0;
let rateLimitQueue: Promise<void> = Promise.resolve();

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

export async function waitForRequestSlot(requestDelayMs: number): Promise<void> {
    let release!: () => void;

    const previous = rateLimitQueue;

    rateLimitQueue = new Promise<void>((resolve) => {
        release = resolve;
    });

    await previous;

    try {
        const now = Date.now();
        const elapsed = now - lastRequestTime;

        if (elapsed < requestDelayMs) {
            await delay(requestDelayMs - elapsed);
        }

        lastRequestTime = Date.now();
    } finally {
        release();
    }
}

export function resolveFetchPageOptions(
    options: FetchPageOptions = {}
): ResolvedFetchPageOptions {
    const resolved = {
        maxAttempts: options.maxAttempts ?? MAX_ATTEMPTS,
        timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT,
        requestDelayMs: options.requestDelayMs ?? REQUEST_DELAY,
    };

    if (!Number.isInteger(resolved.maxAttempts) || resolved.maxAttempts < 1) {
        throw new RangeError("maxAttempts must be a positive integer");
    }
    if (!Number.isFinite(resolved.timeoutMs) || resolved.timeoutMs <= 0) {
        throw new RangeError("timeoutMs must be a positive number");
    }
    if (
        !Number.isFinite(resolved.requestDelayMs) ||
        resolved.requestDelayMs < 0
    ) {
        throw new RangeError("requestDelayMs must be a non-negative number");
    }

    return resolved;
}

export class HttpError extends Error {
    constructor(readonly status: number) {
        super(`HTTP ${status}`);
        this.name = "HttpError";
    }
}

export async function fetchPage(
    url: string,
    options: FetchPageOptions = {}
): Promise<string | null> {
    const { maxAttempts, timeoutMs, requestDelayMs } =
        resolveFetchPageOptions(options);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const controller = new AbortController();

        const timeout = setTimeout(() => {
            controller.abort();
        }, timeoutMs);

        try {
            await waitForRequestSlot(requestDelayMs);

            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    "user-agent": USER_AGENT,
                },
            });

            if (!response.ok) {
                throw new HttpError(response.status);
            }

            const contentType = response.headers.get("content-type");
            const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();

            if (mediaType !== "text/html" && mediaType !== "application/xhtml+xml") {
                console.log(
                    `Skipping ${url}: unsupported Content-Type ${contentType ?? "(missing)"}`
                );
                return null;
            }

            return await response.text();
        } catch (error) {
            const isTimeout = controller.signal.aborted;
            const isHttpError = error instanceof HttpError;
            const isNetworkError = error instanceof TypeError;
            const retryableHttpError =
                isHttpError && (error.status === 429 || error.status >= 500);
            const shouldRetry =
                isTimeout || isNetworkError || retryableHttpError;
            const failureType = isTimeout
                ? "Timeout"
                : isHttpError
                  ? `HTTP ${error.status}`
                  : isNetworkError
                    ? "Network"
                    : "Request";
            const willRetry = shouldRetry && attempt < maxAttempts;
            const errorMessage =
                error instanceof Error ? error.message : String(error);

            console.error(
                `${failureType} failure for ${url} on attempt ${attempt}: ${errorMessage}${willRetry ? "; retrying" : ""}`
            );

            if (!willRetry) {
                throw error;
            }
        } finally {
            clearTimeout(timeout);
        }
    }

    throw new Error("Unexpected fetch failure");
}
