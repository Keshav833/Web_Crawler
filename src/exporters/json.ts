import type { PageResult } from "../types.js";

export function serializeJson(results: PageResult[]): string {
    return JSON.stringify(results, null, 2);
}
