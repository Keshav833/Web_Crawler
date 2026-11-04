import { pathToFileURL } from "node:url";
import { CLI_HELP, parseCliArgs } from "./config.js";
import { Crawler } from "./crawler.js";

export async function runCli(args: string[] = process.argv.slice(2)): Promise<void> {
    let result: ReturnType<typeof parseCliArgs>;
    try {
        result = parseCliArgs(args);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Configuration error: ${message}`);
        console.error("Run `npm run crawl -- --help` for usage.");
        process.exitCode = 1;
        return;
    }

    if (result.kind === "help") {
        console.log(CLI_HELP);
        return;
    }

    try {
        const crawlResult = await new Crawler(result.config).crawl();
        if (!crawlResult) {
            process.exitCode = 1;
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Crawl failed: ${message}`);
        process.exitCode = 1;
    }
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    void runCli();
}
