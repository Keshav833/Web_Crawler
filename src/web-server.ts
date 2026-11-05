import { readFile } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Crawler, type CrawlProgress, type CrawlResult } from "./crawler.js";
import { resolveCrawlerConfig, type CrawlerConfig } from "./config.js";
import { serializeCsv } from "./exporters/csv.js";
import { serializeJson } from "./exporters/json.js";

const WEB_HOST = "127.0.0.1";
const PUBLIC_WEB_HOST = "0.0.0.0";
const MAX_REQUEST_BODY_BYTES = 16_384;
const PUBLIC_DIRECTORY = fileURLToPath(new URL("../public/", import.meta.url));
const PUBLIC_CRAWL_LIMITS = {
    maxDepth: 3,
    maxPages: 100,
    maxConcurrency: 2,
    minRequestDelayMs: 1000,
};
const MAX_PASSWORD_ATTEMPTS = 10;
const PASSWORD_ATTEMPT_WINDOW_MS = 15 * 60_000;
const PASSWORD_ATTEMPT_LIMIT = 1000;
const SECURITY_HEADERS = {
    "content-security-policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "x-robots-tag": "noindex, nofollow, noarchive",
};

type CrawlState = "idle" | "running" | "completed" | "failed";

type WebStatus = {
    state: CrawlState;
    progress: CrawlProgress | null;
    stats: CrawlResult["stats"] | null;
    error: string | null;
};

export type PublicWebOptions = {
    publicOrigin: string;
    crawlPassword: string;
    allowedHosts: readonly string[];
};

export type WebServerOptions = {
    outputPath?: string;
    publicMode?: PublicWebOptions;
};

type PasswordAttempt = {
    count: number;
    windowStartedAt: number;
    blockedUntil: number;
};

class ApiError extends Error {
    constructor(
        readonly statusCode: number,
        message: string
    ) {
        super(message);
    }
}

export function createWebServer(options: WebServerOptions = {}): Server {
    const publicOrigin = options.publicMode
        ? validatePublicOptions(options.publicMode)
        : undefined;
    let state: CrawlState = "idle";
    let progress: CrawlProgress | null = null;
    let result: CrawlResult | null = null;
    let errorMessage: string | null = null;
    const passwordAttempts = new Map<string, PasswordAttempt>();

    return createServer((request, response) => {
        void handleRequest(request, response).catch((error: unknown) => {
            console.error("Web server request failed", error);
            if (!response.headersSent) {
                sendJson(response, 500, { error: "Internal server error" });
            } else {
                response.destroy();
            }
        });
    });

    async function handleRequest(
        request: IncomingMessage,
        response: ServerResponse
    ): Promise<void> {
        if (!isAllowedRequest(request, publicOrigin)) {
            sendJson(response, 403, {
                error: publicOrigin
                    ? "This request did not match the configured public origin."
                    : "This interface is local-only",
            });
            return;
        }

        const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host}`);

        if (request.method === "GET" && requestUrl.pathname === "/") {
            await sendAsset(response, "index.html", "text/html; charset=utf-8");
            return;
        }
        if (request.method === "GET" && requestUrl.pathname === "/app.js") {
            await sendAsset(response, "app.js", "text/javascript; charset=utf-8");
            return;
        }
        if (request.method === "GET" && requestUrl.pathname === "/styles.css") {
            await sendAsset(response, "styles.css", "text/css; charset=utf-8");
            return;
        }
        if (request.method === "GET" && requestUrl.pathname === "/api/config") {
            sendJson(response, 200, {
                crawlPasswordRequired: Boolean(options.publicMode),
                browserModeAvailable: !options.publicMode,
                crawlLimits: options.publicMode ? PUBLIC_CRAWL_LIMITS : null,
                crawlHosts: options.publicMode?.allowedHosts ?? null,
            });
            return;
        }
        if (request.method === "GET" && requestUrl.pathname === "/api/status") {
            sendJson(response, 200, {
                state,
                progress,
                stats: result?.stats ?? null,
                error: errorMessage,
            } satisfies WebStatus);
            return;
        }
        if (request.method === "POST" && requestUrl.pathname === "/api/crawl") {
            if (options.publicMode) {
                const address = getClientAddress(request);
                const attempt = getPasswordAttempt(passwordAttempts, address);
                if (attempt.blockedUntil > Date.now()) {
                    response.setHeader(
                        "retry-after",
                        String(Math.ceil((attempt.blockedUntil - Date.now()) / 1000))
                    );
                    sendJson(response, 429, {
                        error: "Too many password attempts. Try again later.",
                    });
                    return;
                }
                if (
                    !hasValidCrawlPassword(
                        request,
                        options.publicMode.crawlPassword
                    )
                ) {
                    recordPasswordFailure(attempt);
                    if (attempt.blockedUntil > Date.now()) {
                        response.setHeader(
                            "retry-after",
                            String(
                                Math.ceil(
                                    (attempt.blockedUntil - Date.now()) / 1000
                                )
                            )
                        );
                    }
                    sendJson(
                        response,
                        attempt.blockedUntil > Date.now() ? 429 : 401,
                        {
                            error:
                                attempt.blockedUntil > Date.now()
                                    ? "Too many password attempts. Try again later."
                                    : "Enter the dashboard password to start a crawl.",
                        }
                    );
                    return;
                }
                passwordAttempts.delete(address);
            }
            await startCrawl(request, response);
            return;
        }
        if (request.method === "GET" && requestUrl.pathname === "/api/results") {
            if (state !== "completed" || !result) {
                sendJson(response, 409, { error: "No completed crawl results are available" });
                return;
            }
            response.writeHead(200, {
                "content-type": "application/json; charset=utf-8",
                "cache-control": "no-store",
                ...SECURITY_HEADERS,
            });
            response.end(serializeJson(result.pages));
            return;
        }
        if (request.method === "GET" && requestUrl.pathname === "/api/download") {
            if (state !== "completed" || !result) {
                sendJson(response, 409, { error: "No completed crawl results are available" });
                return;
            }
            const format = requestUrl.searchParams.get("format");
            if (format !== "json" && format !== "csv") {
                sendJson(response, 400, { error: "format must be json or csv" });
                return;
            }

            const contents =
                format === "json"
                    ? serializeJson(result.pages)
                    : serializeCsv(result.pages);
            response.writeHead(200, {
                "content-type":
                    format === "json"
                        ? "application/json; charset=utf-8"
                        : "text/csv; charset=utf-8",
                "content-disposition": `attachment; filename="crawl-results.${format}"`,
                "cache-control": "no-store",
                ...SECURITY_HEADERS,
            });
            response.end(contents);
            return;
        }

        sendJson(response, 404, { error: "Not found" });
    }

    async function startCrawl(
        request: IncomingMessage,
        response: ServerResponse
    ): Promise<void> {
        if (state === "running") {
            sendJson(response, 409, { error: "A crawl is already running" });
            return;
        }

        let config: CrawlerConfig;
        try {
            config = parseWebConfig(
                await readJsonBody(request),
                options.outputPath,
                options.publicMode?.allowedHosts
            );
        } catch (error) {
            const statusCode = error instanceof ApiError ? error.statusCode : 400;
            const message = error instanceof Error ? error.message : String(error);
            sendJson(response, statusCode, { error: message });
            return;
        }

        result = null;
        progress = null;
        errorMessage = null;
        state = "running";
        sendJson(response, 202, { state });

        const crawler = new Crawler({
            ...config,
            ...(options.publicMode
                ? {
                      fetchPageOptions: {
                          allowedRedirectHosts: [
                              new URL(config.startUrl).hostname.toLowerCase(),
                          ],
                          maxResponseBytes: 1_000_000,
                      },
                      shouldCrawlUrl: (url: string) =>
                          isAllowedPublicTarget(
                              url,
                              options.publicMode!.allowedHosts
                          ),
                  }
                : {}),
            onProgress: (nextProgress) => {
                progress = nextProgress;
            },
        });

        void crawler
            .crawl()
            .then((crawlResult) => {
                if (!crawlResult) {
                    state = "failed";
                    errorMessage =
                        "The crawler stopped because robots.txt could not be checked.";
                    return;
                }
                result = crawlResult;
                state = "completed";
            })
            .catch((error: unknown) => {
                console.error("Web crawl failed", error);
                state = "failed";
                errorMessage =
                    error instanceof Error ? error.message : String(error);
            });
    }
}

export async function startWebServer(
    port = 3000,
    options: WebServerOptions = {}
): Promise<Server> {
    const server = createWebServer(options);
    const host = options.publicMode ? PUBLIC_WEB_HOST : WEB_HOST;
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
    });
    return server;
}

function isAllowedRequest(request: IncomingMessage, publicOrigin?: URL): boolean {
    if (!publicOrigin) {
        return isLocalRequest(request);
    }

    const hostHeader = request.headers.host;
    if (!hostHeader || hostHeader.toLowerCase() !== publicOrigin.host) {
        return false;
    }
    if (request.headers["x-forwarded-proto"] !== "https") {
        return false;
    }

    const originHeader = request.headers.origin;
    if (originHeader) {
        return originHeader === publicOrigin.origin;
    }
    return request.method === "GET" || request.method === "HEAD";
}

function isLocalRequest(request: IncomingMessage): boolean {
    const hostHeader = request.headers.host;
    if (!hostHeader) {
        return false;
    }

    let host: URL;
    try {
        host = new URL(`http://${hostHeader}`);
    } catch {
        return false;
    }

    const serverAddress = request.socket.localAddress;
    const isLoopbackHost =
        host.hostname === "127.0.0.1" || host.hostname === "localhost";
    const isLoopbackServer =
        serverAddress === "127.0.0.1" || serverAddress === "::ffff:127.0.0.1";
    if (!isLoopbackHost || !isLoopbackServer) {
        return false;
    }

    const originHeader = request.headers.origin;
    if (!originHeader) {
        return true;
    }
    try {
        const origin = new URL(originHeader);
        return (
            origin.protocol === "http:" &&
            (origin.hostname === "127.0.0.1" || origin.hostname === "localhost") &&
            origin.port === host.port
        );
    } catch {
        return false;
    }
}

async function sendAsset(
    response: ServerResponse,
    fileName: string,
    contentType: string
): Promise<void> {
    const contents = await readFile(join(PUBLIC_DIRECTORY, fileName));
    response.writeHead(200, {
        "content-type": contentType,
        "cache-control": "no-cache",
        ...SECURITY_HEADERS,
    });
    response.end(contents);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.byteLength;
        if (size > MAX_REQUEST_BODY_BYTES) {
            throw new ApiError(413, "Request body is too large");
        }
        chunks.push(buffer);
    }

    const contentType = request.headers["content-type"]?.split(";")[0]?.trim();
    if (contentType !== "application/json") {
        throw new ApiError(415, "Content-Type must be application/json");
    }

    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
        throw new ApiError(400, "Request body must be valid JSON");
    }
}

function parseWebConfig(
    value: unknown,
    outputPath = "results.json",
    allowedHosts?: readonly string[]
): CrawlerConfig {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ApiError(400, "Request body must be a JSON object");
    }

    const body = value as Record<string, unknown>;
    const allowedKeys = new Set([
        "startUrl",
        "maxDepth",
        "concurrency",
        "requestDelayMs",
        "maxPages",
        "mode",
        "navigationTimeoutMs",
    ]);
    for (const key of Object.keys(body)) {
        if (!allowedKeys.has(key)) {
            throw new ApiError(400, `Unsupported configuration option: ${key}`);
        }
    }

    if (body.startUrl !== undefined && typeof body.startUrl !== "string") {
        throw new ApiError(400, "startUrl must be a string");
    }
    for (const key of [
        "maxDepth",
        "concurrency",
        "requestDelayMs",
        "maxPages",
        "navigationTimeoutMs",
    ]) {
        const option = body[key];
        if (option !== undefined && (typeof option !== "number" || !Number.isInteger(option))) {
            throw new ApiError(400, `${key} must be a whole number`);
        }
    }
    if (
        body.mode !== undefined &&
        body.mode !== "http" &&
        body.mode !== "browser"
    ) {
        throw new ApiError(400, "mode must be http or browser");
    }

    const overrides: Partial<CrawlerConfig> = {
        outputPath,
        format: "json",
    };
    if (typeof body.startUrl === "string") overrides.startUrl = body.startUrl;
    if (typeof body.maxDepth === "number") overrides.maxDepth = body.maxDepth;
    if (typeof body.concurrency === "number") overrides.concurrency = body.concurrency;
    if (typeof body.requestDelayMs === "number") overrides.requestDelayMs = body.requestDelayMs;
    if (typeof body.maxPages === "number") overrides.maxPages = body.maxPages;
    if (body.mode === "http" || body.mode === "browser") overrides.mode = body.mode;
    if (typeof body.navigationTimeoutMs === "number") {
        overrides.navigationTimeoutMs = body.navigationTimeoutMs;
    }

    try {
        const config = resolveCrawlerConfig(overrides);
        if (allowedHosts) {
            const startUrl = new URL(config.startUrl);
            if (!isAllowedPublicTarget(config.startUrl, allowedHosts)) {
                throw new Error(
                    "startUrl must use HTTPS and a hostname in the server's crawl allowlist"
                );
            }
            if (config.mode !== "http") {
                throw new Error("Browser mode is disabled for public crawls");
            }
            if (
                config.maxDepth > PUBLIC_CRAWL_LIMITS.maxDepth ||
                config.maxPages > PUBLIC_CRAWL_LIMITS.maxPages ||
                config.concurrency > PUBLIC_CRAWL_LIMITS.maxConcurrency ||
                config.requestDelayMs < PUBLIC_CRAWL_LIMITS.minRequestDelayMs
            ) {
                throw new Error(
                    `Public crawl limits: depth <= ${PUBLIC_CRAWL_LIMITS.maxDepth}, pages <= ${PUBLIC_CRAWL_LIMITS.maxPages}, workers <= ${PUBLIC_CRAWL_LIMITS.maxConcurrency}, delay >= ${PUBLIC_CRAWL_LIMITS.minRequestDelayMs}ms`
                );
            }
            if (
                startUrl.port !== "" &&
                startUrl.port !== "443" &&
                startUrl.port !== "80"
            ) {
                throw new Error("Public crawls may only use standard HTTP or HTTPS ports");
            }
        }
        return config;
    } catch (error) {
        if (error instanceof ApiError) {
            throw error;
        }
        throw new ApiError(
            400,
            error instanceof Error ? error.message : String(error)
        );
    }
}

function validatePublicOptions(options: PublicWebOptions): URL {
    let origin: URL;
    try {
        origin = new URL(options.publicOrigin);
    } catch {
        throw new Error("PUBLIC_ORIGIN must be a valid HTTPS origin");
    }
    if (
        origin.protocol !== "https:" ||
        origin.username ||
        origin.password ||
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash
    ) {
        throw new Error("PUBLIC_ORIGIN must be an HTTPS origin without a path");
    }
    if (Buffer.byteLength(options.crawlPassword, "utf8") < 20) {
        throw new Error("DASHBOARD_PASSWORD must be at least 20 bytes");
    }
    if (options.allowedHosts.length === 0) {
        throw new Error("CRAWL_ALLOWED_HOSTS must contain at least one hostname");
    }
    for (const host of options.allowedHosts) {
        let parsedHost: URL | undefined;
        try {
            parsedHost = new URL(`https://${host}`);
        } catch {
            parsedHost = undefined;
        }
        if (
            !host ||
            host !== host.trim().toLowerCase() ||
            host.endsWith(".") ||
            !parsedHost ||
            parsedHost.hostname !== host ||
            parsedHost.port !== "" ||
            parsedHost.pathname !== "/" ||
            isIP(host) !== 0 ||
            host === "localhost" ||
            host.endsWith(".localhost") ||
            host.endsWith(".local") ||
            host.endsWith(".internal")
        ) {
            throw new Error(`Invalid public crawl hostname: ${host}`);
        }
    }
    return origin;
}

function hasValidCrawlPassword(
    request: IncomingMessage,
    expectedPassword: string
): boolean {
    const suppliedPassword = request.headers["x-dashboard-password"];
    if (typeof suppliedPassword !== "string") {
        return false;
    }

    const suppliedHash = createHash("sha256").update(suppliedPassword).digest();
    const expectedHash = createHash("sha256").update(expectedPassword).digest();
    return timingSafeEqual(suppliedHash, expectedHash);
}

function getClientAddress(request: IncomingMessage): string {
    const forwardedFor = request.headers["x-forwarded-for"];
    if (typeof forwardedFor === "string") {
        const addresses = forwardedFor.split(",").map((address) => address.trim());
        const proxyReportedAddress = addresses.at(-1);
        if (proxyReportedAddress && isIP(proxyReportedAddress) !== 0) {
            return proxyReportedAddress;
        }
    }
    return request.socket.remoteAddress ?? "unknown";
}

function getPasswordAttempt(
    attempts: Map<string, PasswordAttempt>,
    address: string
): PasswordAttempt {
    const now = Date.now();
    for (const [key, attempt] of attempts) {
        if (
            attempt.blockedUntil <= now &&
            now - attempt.windowStartedAt >= PASSWORD_ATTEMPT_WINDOW_MS
        ) {
            attempts.delete(key);
        }
    }

    let attempt = attempts.get(address);
    if (!attempt || now - attempt.windowStartedAt >= PASSWORD_ATTEMPT_WINDOW_MS) {
        attempt = { count: 0, windowStartedAt: now, blockedUntil: 0 };
        attempts.set(address, attempt);
    }
    if (attempts.size > PASSWORD_ATTEMPT_LIMIT) {
        const oldestAddress = attempts.keys().next().value;
        if (oldestAddress !== undefined && oldestAddress !== address) {
            attempts.delete(oldestAddress);
        }
    }
    return attempt;
}

function recordPasswordFailure(attempt: PasswordAttempt): void {
    attempt.count++;
    if (attempt.count >= MAX_PASSWORD_ATTEMPTS) {
        attempt.blockedUntil = Date.now() + PASSWORD_ATTEMPT_WINDOW_MS;
    }
}

function isAllowedPublicTarget(
    value: string,
    allowedHosts: readonly string[]
): boolean {
    try {
        const url = new URL(value);
        return (
            url.protocol === "https:" &&
            !url.username &&
            !url.password &&
            isIP(url.hostname) === 0 &&
            allowedHosts.includes(url.hostname.toLowerCase()) &&
            (url.port === "" || url.port === "443")
        );
    } catch {
        return false;
    }
}

function sendJson(
    response: ServerResponse,
    statusCode: number,
    value: unknown
): void {
    response.writeHead(statusCode, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...SECURITY_HEADERS,
    });
    response.end(JSON.stringify(value));
}
