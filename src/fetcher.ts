export const USER_AGENT = "MyCrawler/1.0";

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT = 5000;
const REQUEST_DELAY = 1000;

export type FetchPageOptions = {
    maxAttempts?: number;
    timeoutMs?: number;
    requestDelayMs?: number;
    allowedRedirectHosts?: readonly string[];
    maxResponseBytes?: number;
};

export type ResolvedFetchPageOptions = Required<
    Pick<
        FetchPageOptions,
        "maxAttempts" | "timeoutMs" | "requestDelayMs"
    >
> &
    Pick<FetchPageOptions, "allowedRedirectHosts" | "maxResponseBytes">;

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

export async function fetchWithRedirectPolicy(
    url: string,
    init: RequestInit,
    allowedRedirectHosts?: readonly string[],
    beforeRequest?: () => Promise<void>
): Promise<Response> {
    if (!allowedRedirectHosts) {
        await beforeRequest?.();
        return fetch(url, init);
    }

    let currentUrl = new URL(url);
    validateAllowedUrl(currentUrl, allowedRedirectHosts);

    for (let redirectCount = 0; ; redirectCount++) {
        await beforeRequest?.();
        const response = await fetch(currentUrl, {
            ...init,
            redirect: "manual",
        });
        if (response.status < 300 || response.status >= 400) {
            return response;
        }

        const location = response.headers.get("location");
        if (!location) {
            return response;
        }
        if (redirectCount >= 5) {
            await response.body?.cancel();
            throw new Error("Too many redirects");
        }

        const nextUrl = new URL(location, currentUrl);
        try {
            validateAllowedUrl(nextUrl, allowedRedirectHosts);
        } catch (error) {
            await response.body?.cancel();
            throw error;
        }
        await response.body?.cancel();
        currentUrl = nextUrl;
    }
}

function validateAllowedUrl(url: URL, allowedHosts: readonly string[]): void {
    const portIsAllowed = url.port === "" || url.port === "443";
    if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !portIsAllowed ||
        !allowedHosts.includes(url.hostname.toLowerCase())
    ) {
        throw new Error("Request or redirect is outside the configured crawl host policy");
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
    if (
        options.maxResponseBytes !== undefined &&
        (!Number.isSafeInteger(options.maxResponseBytes) ||
            options.maxResponseBytes < 1)
    ) {
        throw new RangeError("maxResponseBytes must be a positive safe integer");
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
            const response = await fetchWithRedirectPolicy(
                url,
                {
                    signal: controller.signal,
                    headers: {
                        "user-agent": USER_AGENT,
                    },
                },
                options.allowedRedirectHosts,
                () => waitForRequestSlot(requestDelayMs)
            );

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

            return await readResponseText(response, options.maxResponseBytes);
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

export async function readResponseText(
    response: Response,
    maxResponseBytes?: number
): Promise<string> {
    if (maxResponseBytes === undefined) {
        return response.text();
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
        await response.body?.cancel();
        throw new Error(`Response exceeds the ${maxResponseBytes}-byte limit`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
        return "";
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        totalBytes += value.byteLength;
        if (totalBytes > maxResponseBytes) {
            await reader.cancel();
            throw new Error(`Response exceeds the ${maxResponseBytes}-byte limit`);
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
}
