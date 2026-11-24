import { Pool } from "pg";
import {
    PostgresCrawlJobStore,
    type CrawlJobStore,
} from "./job-store.js";
import { startWebServer, type PublicWebOptions } from "./web-server.js";

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("PORT must be an integer between 1 and 65535");
}

function requireEnvironmentValue(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`${name} is required when PUBLIC_DEPLOYMENT=true`);
    }
    return value;
}

function getPublicModeOptions(): PublicWebOptions | undefined {
    if (process.env.PUBLIC_DEPLOYMENT !== "true") {
        return undefined;
    }

    return {
        publicOrigin: requireEnvironmentValue("PUBLIC_ORIGIN"),
        crawlPassword: requireEnvironmentValue("DASHBOARD_PASSWORD"),
        allowedHosts: requireEnvironmentValue("CRAWL_ALLOWED_HOSTS")
            .split(",")
            .map((host) => host.trim().toLowerCase())
            .filter(Boolean),
    };
}

function getJobStore(): CrawlJobStore | undefined {
    const connectionString = process.env.DATABASE_URL?.trim();
    if (!connectionString) {
        if (process.env.PUBLIC_DEPLOYMENT === "true") {
            throw new Error("DATABASE_URL is required for public deployment");
        }
        return undefined;
    }

    const pool = new Pool({
        connectionString,
        ...(process.env.PGSSL === "true"
            ? { ssl: { rejectUnauthorized: true } }
            : {}),
    });
    pool.on("error", (error) => {
        console.error("Unexpected PostgreSQL pool error", error);
    });
    return new PostgresCrawlJobStore(pool);
}

let publicMode: PublicWebOptions | undefined;
let jobStore: CrawlJobStore | undefined;
try {
    publicMode = getPublicModeOptions();
    jobStore = getJobStore();
} catch (error) {
    console.error("Could not configure the crawler dashboard", error);
    process.exitCode = 1;
}

if (process.exitCode !== 1) {
    void startWebServer(port, {
        ...(publicMode ? { publicMode } : {}),
        ...(jobStore ? { jobStore } : {}),
    })
        .then(() => {
            const host = publicMode ? "0.0.0.0" : "127.0.0.1";
            console.log(`Crawler dashboard listening on ${host}:${port}`);
            console.log("Press Ctrl+C to stop the dashboard.");
        })
        .catch((error: unknown) => {
            console.error("Could not start the crawler dashboard", error);
            process.exitCode = 1;
        });
}
