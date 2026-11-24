/**
 * URL filtering system for including/excluding URLs based on patterns
 */

export interface UrlFilterConfig {
    includePatterns?: string[]; // Regex patterns to include
    excludePatterns?: string[]; // Regex patterns to exclude
}

export class UrlFilter {
    private includeRegexes: RegExp[] = [];
    private excludeRegexes: RegExp[] = [];

    constructor(config?: UrlFilterConfig) {
        if (config?.includePatterns) {
            this.includeRegexes = config.includePatterns.map(
                (p) => new RegExp(p)
            );
        }
        if (config?.excludePatterns) {
            this.excludeRegexes = config.excludePatterns.map(
                (p) => new RegExp(p)
            );
        }
    }

    /**
     * Tests if a URL should be included based on filters
     * @returns true if URL should be crawled, false otherwise
     */
    shouldInclude(url: string): boolean {
        // If include patterns are specified, URL must match at least one
        if (this.includeRegexes.length > 0) {
            const matches = this.includeRegexes.some((regex) =>
                regex.test(url)
            );
            if (!matches) {
                return false;
            }
        }

        // Check exclude patterns - any match means exclude
        if (this.excludeRegexes.length > 0) {
            const matches = this.excludeRegexes.some((regex) =>
                regex.test(url)
            );
            if (matches) {
                return false;
            }
        }

        return true;
    }

    /**
     * Filters a list of URLs
     */
    filter(urls: string[]): string[] {
        return urls.filter((url) => this.shouldInclude(url));
    }

    /**
     * Adds an include pattern
     */
    addIncludePattern(pattern: string): void {
        try {
            this.includeRegexes.push(new RegExp(pattern));
        } catch (error) {
            throw new Error(`Invalid regex pattern: ${pattern}`);
        }
    }

    /**
     * Adds an exclude pattern
     */
    addExcludePattern(pattern: string): void {
        try {
            this.excludeRegexes.push(new RegExp(pattern));
        } catch (error) {
            throw new Error(`Invalid regex pattern: ${pattern}`);
        }
    }
}

/**
 * Common URL filter presets
 */
export const URL_FILTER_PRESETS = {
    // Include only product pages
    productsOnly: {
        includePatterns: ["/product", "/item", "/goods"],
    },

    // Exclude admin and system paths
    noAdmin: {
        excludePatterns: [
            "/admin",
            "/dashboard",
            "/api",
            "/settings",
            "/account",
        ],
    },

    // Exclude common non-content paths
    noSystemPaths: {
        excludePatterns: [
            "/search",
            "/filter",
            "/sort",
            "/page",
            "\\.pdf$",
            "\\.doc$",
            "\\.zip$",
        ],
    },

    // Blog posts only
    blogOnly: {
        includePatterns: ["/blog", "/post", "/article"],
    },

    // Exclude media files and archives
    noMedia: {
        excludePatterns: [
            "\\.(jpg|jpeg|png|gif|svg|webp|pdf|zip|rar|7z|exe|dmg)$",
        ],
    },
};

/**
 * Tests if a path looks like a file (not a page)
 */
export function isLikelyFile(url: string): boolean {
    const fileExtensions = [
        ".pdf",
        ".doc",
        ".docx",
        ".xls",
        ".xlsx",
        ".ppt",
        ".pptx",
        ".zip",
        ".rar",
        ".7z",
        ".exe",
        ".dmg",
        ".iso",
        ".tar",
        ".gz",
        ".mp3",
        ".mp4",
        ".avi",
        ".mov",
        ".mkv",
        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        ".svg",
        ".webp",
        ".ico",
        ".css",
        ".js",
        ".json",
        ".xml",
        ".rss",
        ".txt",
        ".csv",
    ];

    const lowerUrl = url.toLowerCase();
    return fileExtensions.some((ext) => lowerUrl.endsWith(ext));
}

/**
 * Tests if a URL is likely a pagination or sort parameter
 */
export function isLikelyTrackingUrl(url: string): boolean {
    const trackingPatterns = [
        /[?&](utm_|ga_|fbclid|gclid|msclkid|page|sort|filter|q=)/i,
        /\/page\//i,
        /\/category\//i,
        /\/tag\//i,
        /[?&]ref=/i,
        /[?&]redirect=/i,
    ];

    return trackingPatterns.some((pattern) => pattern.test(url));
}
