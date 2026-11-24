import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCrawlerConfig } from "../src/config.js";
import {
    ActiveCrawlError,
    PostgresCrawlJobStore,
} from "../src/job-store.js";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("PostgresCrawlJobStore", () => {
    let pool: Pool | undefined;
    let store: PostgresCrawlJobStore | undefined;
    const jobIds: string[] = [];

    afterEach(async () => {
        if (jobIds.length > 0) {
            await pool?.query(
                "DELETE FROM crawler_jobs WHERE id = ANY($1::uuid[])",
                [jobIds]
            );
            jobIds.length = 0;
        }
        await pool?.end();
        pool = undefined;
        store = undefined;
    });

    it("persists crawl status and results across store instances", async () => {
        pool = new Pool({ connectionString: databaseUrl! });
        store = new PostgresCrawlJobStore(pool);
        await store.initialize();

        const job = await store.createJob(
            resolveCrawlerConfig({ maxDepth: 0 }),
            `test-${randomUUID()}`
        );
        jobIds.push(job.id);
        await store.updateProgress(job.id, {
            discoveredUrls: 1,
            queuedUrls: 1,
            scrapedPages: 1,
            failedPages: 0,
            skippedPages: 0,
            maxObservedConcurrency: 1,
            activeWorkers: 0,
            outstandingTasks: 0,
            completedPages: 1,
        });

        const pages = [{
            url: "https://example.com/",
            title: "Example",
            description: "",
            headings: ["Home"],
            linksCount: 0,
        }];
        const stats = {
            discoveredUrls: 1,
            queuedUrls: 1,
            scrapedPages: 1,
            failedPages: 0,
            skippedPages: 0,
            maxObservedConcurrency: 1,
            activeWorkers: 0,
            outstandingTasks: 0,
            crawlDurationMs: 20,
            exportPath: "results.json",
        };
        await store.completeJob(job.id, { pages, stats });

        const reopenedStore = new PostgresCrawlJobStore(pool);
        const persisted = await reopenedStore.getJob(job.id, true);
        expect(persisted).toMatchObject({
            id: job.id,
            state: "completed",
            progress: { completedPages: 1 },
            stats: { scrapedPages: 1 },
            pages,
        });
        expect(await reopenedStore.getLatestJob()).toMatchObject({
            id: job.id,
            state: "completed",
        });
    });

    it("prevents parallel active crawls and recovers jobs with expired leases", async () => {
        pool = new Pool({ connectionString: databaseUrl! });
        store = new PostgresCrawlJobStore(pool);
        await store.initialize();

        const job = await store.createJob(
            resolveCrawlerConfig(),
            `test-${randomUUID()}`
        );
        jobIds.push(job.id);
        await expect(
            store.createJob(resolveCrawlerConfig(), `test-${randomUUID()}`)
        ).rejects.toBeInstanceOf(ActiveCrawlError);

        await pool.query(
            "UPDATE crawler_jobs SET lease_until = NOW() - INTERVAL '1 second' WHERE id = $1",
            [job.id]
        );
        await store.initialize();
        expect(await store.getJob(job.id)).toMatchObject({
            state: "interrupted",
            error: expect.stringContaining("lease expired"),
        });

        const nextJob = await store.createJob(
            resolveCrawlerConfig(),
            `test-${randomUUID()}`
        );
        jobIds.push(nextJob.id);
        await store.failJob(nextJob.id, "test cleanup");
    });
});
