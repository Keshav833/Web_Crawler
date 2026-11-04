const UNSUPPORTED_EXTENSIONS = new Set([
    "xml", "rss", "json", "pdf",
    "jpg", "jpeg", "png", "gif", "webp", "svg", "ico", "bmp", "avif",
    "mp3", "mp4", "wav", "avi", "mov", "webm",
    "css", "js", "mjs",
    "woff", "woff2", "ttf", "otf", "eot",
    "zip", "rar", "7z", "gz", "tar",
    "doc", "docx", "xls", "xlsx", "ppt", "pptx",
]);

export function normalizeUrl(rawUrl: string, baseUrl: string): string | null {
    try {
        const url = new URL(rawUrl, baseUrl);

        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return null;
        }

        const extension = url.pathname.match(/\.([^.\/]+)$/)?.[1]?.toLowerCase();
        if (extension && UNSUPPORTED_EXTENSIONS.has(extension)) {
            return null;
        }

        url.hash = "";

        const trackingParams = [
            "utm_source",
            "utm_medium",
            "utm_campaign",
            "utm_term",
            "utm_content",
            "fbclid",
            "gclid",
        ];

        for (const param of trackingParams) {
            url.searchParams.delete(param);
        }

        return url.href;
    } catch {
        return null;
    }
}
