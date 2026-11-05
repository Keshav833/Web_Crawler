import { createRequire } from "node:module";
import {
    fetchWithRedirectPolicy,
    HttpError,
    readResponseText,
    USER_AGENT,
} from "./fetcher.js";

type RobotsParser = typeof import("robots-parser").default;

const robotsParser: RobotsParser =
    createRequire(import.meta.url)("robots-parser");

export type RobotsPolicy = ReturnType<RobotsParser>;

const REQUEST_TIMEOUT = 5000;

export async function getRobotsParser(
    startUrl: string,
    timeoutMs = REQUEST_TIMEOUT,
    allowedRedirectHosts?: readonly string[],
    maxResponseBytes?: number
): Promise<RobotsPolicy | null> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new RangeError("timeoutMs must be a positive number");
    }

    const origin = new URL(startUrl).origin;
    const robotsUrl = `${origin}/robots.txt`;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
        controller.abort();
    }, timeoutMs);

    try {
        const response = await fetchWithRedirectPolicy(
            robotsUrl,
            {
                signal: controller.signal,
                headers: {
                    "user-agent": USER_AGENT,
                },
            },
            allowedRedirectHosts
        );

        if (response.status === 404) {
            console.log("robots.txt returned 404; proceeding without robots rules");
            return null;
        }

        if (!response.ok) {
            throw new HttpError(response.status);
        }

        const robotsText = await readResponseText(response, maxResponseBytes);

        return robotsParser(robotsUrl, robotsText);
    } catch (error) {
        if (controller.signal.aborted) {
            throw new Error(`Timed out while fetching robots.txt after ${timeoutMs}ms`);
        }
        if (error instanceof HttpError) {
            throw error;
        }
        if (error instanceof TypeError) {
            throw new Error(`Network error fetching robots.txt: ${error.message}`);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}
