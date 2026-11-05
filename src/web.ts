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

let publicMode: PublicWebOptions | undefined;
try {
    publicMode = getPublicModeOptions();
} catch (error) {
    console.error("Could not configure the crawler dashboard", error);
    process.exitCode = 1;
}

if (process.exitCode !== 1) {
    void startWebServer(port, publicMode ? { publicMode } : {})
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
