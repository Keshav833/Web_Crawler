export type StructuredData = {
    jsonLd?: Record<string, unknown>[];
    openGraph?: Record<string, string>;
    schema?: Record<string, unknown>[];
};

export type PageResult = {
    url: string;
    title: string;
    description: string;
    headings: string[];
    linksCount: number;
    // Extended fields for enhanced extraction
    customFields?: Record<string, unknown>;
    structuredData?: StructuredData;
    crawledAt: number;
    statusCode?: number;
    error?: string;
    redirectUrl?: string;
};

export type ExtractionConfig = {
    includeStructuredData: boolean;
    customSelectors?: Record<string, string>; // CSS selector mappings
    followSitemaps: boolean;
    urlFilters?: {
        include?: string[]; // regex patterns
        exclude?: string[]; // regex patterns
    };
};

export type ErrorLog = {
    url: string;
    statusCode?: number;
    errorType: "timeout" | "network" | "parse" | "4xx" | "5xx" | "other";
    message: string;
    timestamp: number;
    retriedCount: number;
};
