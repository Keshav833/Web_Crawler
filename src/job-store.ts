import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { CrawlerConfig } from "./config.js";
import type { CrawlProgress, CrawlStats } from "./crawler.js";
import type { PageResult } from "./types.js";

export type CrawlJobState =
    | "running"
    | "completed"
    | "failed"
    | "interrupted";

export type CrawlJob = {
    id: string;
    state: CrawlJobState;
    progress: CrawlProgress | null;
    stats: CrawlStats | null;
    error: string | null;
    pages: PageResult[] | null;
    createdAt: string;
    updatedAt: string;
};

export class ActiveCrawlError extends Error {
    constructor() {
        super("A crawl is already running");
        this.name = "ActiveCrawlError";
    }
}

export interface CrawlJobStore {
    initialize(): Promise<void>;
    createJob(config: CrawlerConfig, workerId: string): Promise<CrawlJob>;
    updateProgress(id: string, progress: CrawlProgress): Promise<void>;
    completeJob(id: string, result: { pages: PageResult[]; stats: CrawlStats }): Promise<void>;
    failJob(id: string, error: string): Promise<void>;
    getLatestJob(includePages?: boolean): Promise<CrawlJob | null>;
    getJob(id: string, includePages?: boolean): Promise<CrawlJob | null>;
    listJobs(limit?: number): Promise<CrawlJob[]>;
    heartbeat(workerId: string): Promise<void>;
    healthCheck(): Promise<void>;
    close(): Promise<void>;
}

const LEASE_DURATION_SECONDS = 60;

export class InMemoryCrawlJobStore implements CrawlJobStore {
    private job: CrawlJob | null = null;

    async initialize(): Promise<void> {}

    async createJob(): Promise<CrawlJob> {
        if (this.job?.state === "running") {
            throw new ActiveCrawlError();
        }

        const now = new Date().toISOString();
        const job: CrawlJob = {
            id: randomUUID(),
            state: "running",
            progress: null,
            stats: null,
            error: null,
            pages: null,
            createdAt: now,
            updatedAt: now,
        };
        this.job = job;
        return job;
    }

    async updateProgress(id: string, progress: CrawlProgress): Promise<void> {
        const job = this.findRunningJob(id);
        job.progress = progress;
        job.updatedAt = new Date().toISOString();
    }

    async completeJob(
        id: string,
        result: { pages: PageResult[]; stats: CrawlStats }
    ): Promise<void> {
        const job = this.findRunningJob(id);
        job.state = "completed";
        job.pages = result.pages;
        job.stats = result.stats;
        job.updatedAt = new Date().toISOString();
    }

    async failJob(id: string, error: string): Promise<void> {
        const job = this.findRunningJob(id);
        job.state = "failed";
        job.error = error;
        job.updatedAt = new Date().toISOString();
    }

    async getLatestJob(): Promise<CrawlJob | null> {
        return this.job;
    }

    async getJob(id: string): Promise<CrawlJob | null> {
        return this.job?.id === id ? this.job : null;
    }

    async listJobs(): Promise<CrawlJob[]> {
        return this.job ? [{ ...this.job, pages: null }] : [];
    }

    async heartbeat(): Promise<void> {}

    async healthCheck(): Promise<void> {}

    async close(): Promise<void> {}

    private findRunningJob(id: string): CrawlJob {
        const job =
            this.job?.id === id && this.job.state === "running"
                ? this.job
                : null;
        if (!job) {
            throw new Error(`Running crawl job ${id} was not found`);
        }
        return job;
    }
}

type JobRow = {
    id: string;
    state: CrawlJobState;
    progress: CrawlProgress | null;
    stats: CrawlStats | null;
    error: string | null;
    pages: PageResult[] | null;
    created_at: Date;
    updated_at: Date;
};

export class PostgresCrawlJobStore implements CrawlJobStore {
    constructor(private readonly pool: Pool) {}

    async initialize(): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(`
                CREATE TABLE IF NOT EXISTS crawler_jobs (
                    id UUID PRIMARY KEY,
                    state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'interrupted')),
                    config JSONB NOT NULL,
                    progress JSONB,
                    stats JSONB,
                    results JSONB,
                    error TEXT,
                    worker_id TEXT,
                    lease_until TIMESTAMPTZ,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    completed_at TIMESTAMPTZ
                )
            `);
            await client.query(`
                CREATE UNIQUE INDEX IF NOT EXISTS crawler_jobs_one_running
                ON crawler_jobs ((state))
                WHERE state = 'running'
            `);
            await client.query(`
                CREATE INDEX IF NOT EXISTS crawler_jobs_created_at
                ON crawler_jobs (created_at DESC)
            `);
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
        await this.recoverExpiredJobs();
    }

    async createJob(config: CrawlerConfig, workerId: string): Promise<CrawlJob> {
        await this.recoverExpiredJobs();
        await this.pruneOldJobs();
        const id = randomUUID();
        try {
            const result = await this.pool.query<JobRow>(
                `INSERT INTO crawler_jobs
                    (id, state, config, worker_id, lease_until)
                 VALUES ($1, 'running', $2::jsonb, $3, NOW() + ($4 * INTERVAL '1 second'))
                 RETURNING id, state, progress, stats, error, results AS pages, created_at, updated_at`,
                [id, JSON.stringify(config), workerId, LEASE_DURATION_SECONDS]
            );
            return mapJob(result.rows[0]!);
        } catch (error) {
            if (isUniqueViolation(error)) {
                throw new ActiveCrawlError();
            }
            throw error;
        }
    }

    async updateProgress(id: string, progress: CrawlProgress): Promise<void> {
        const result = await this.pool.query(
            `UPDATE crawler_jobs
             SET progress = $2::jsonb, updated_at = NOW(),
                 lease_until = NOW() + ($3 * INTERVAL '1 second')
             WHERE id = $1 AND state = 'running'`,
            [id, JSON.stringify(progress), LEASE_DURATION_SECONDS]
        );
        assertUpdated(result.rowCount, id);
    }

    async completeJob(
        id: string,
        result: { pages: PageResult[]; stats: CrawlStats }
    ): Promise<void> {
        const queryResult = await this.pool.query(
            `UPDATE crawler_jobs
             SET state = 'completed', results = $2::jsonb, stats = $3::jsonb,
                 updated_at = NOW(), completed_at = NOW(),
                 worker_id = NULL, lease_until = NULL
             WHERE id = $1 AND state = 'running'`,
            [id, JSON.stringify(result.pages), JSON.stringify(result.stats)]
        );
        assertUpdated(queryResult.rowCount, id);
    }

    async failJob(id: string, error: string): Promise<void> {
        const queryResult = await this.pool.query(
            `UPDATE crawler_jobs
             SET state = 'failed', error = $2, updated_at = NOW(),
                 completed_at = NOW(), worker_id = NULL, lease_until = NULL
             WHERE id = $1 AND state = 'running'`,
            [id, error]
        );
        assertUpdated(queryResult.rowCount, id);
    }

    async getLatestJob(includePages = false): Promise<CrawlJob | null> {
        const result = await this.pool.query<JobRow>(
            `SELECT id, state, progress, stats, error,
                    ${includePages ? "results" : "NULL::jsonb"} AS pages,
                    created_at, updated_at
             FROM crawler_jobs ORDER BY created_at DESC LIMIT 1`
        );
        return result.rows[0] ? mapJob(result.rows[0]) : null;
    }

    async getJob(id: string, includePages = false): Promise<CrawlJob | null> {
        const result = await this.pool.query<JobRow>(
            `SELECT id, state, progress, stats, error,
                    ${includePages ? "results" : "NULL::jsonb"} AS pages,
                    created_at, updated_at
             FROM crawler_jobs WHERE id = $1`,
            [id]
        );
        return result.rows[0] ? mapJob(result.rows[0]) : null;
    }

    async listJobs(limit = 20): Promise<CrawlJob[]> {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
            throw new RangeError("limit must be an integer between 1 and 100");
        }
        const result = await this.pool.query<JobRow>(
            `SELECT id, state, progress, stats, error, NULL::jsonb AS pages,
                    created_at, updated_at
             FROM crawler_jobs ORDER BY created_at DESC LIMIT $1`,
            [limit]
        );
        return result.rows.map(mapJob);
    }

    async heartbeat(workerId: string): Promise<void> {
        await this.pool.query(
            `UPDATE crawler_jobs
             SET lease_until = NOW() + ($2 * INTERVAL '1 second')
             WHERE worker_id = $1 AND state = 'running'`,
            [workerId, LEASE_DURATION_SECONDS]
        );
    }

    async healthCheck(): Promise<void> {
        await this.pool.query("SELECT 1");
    }

    async close(): Promise<void> {
        await this.pool.end();
    }

    private async recoverExpiredJobs(): Promise<void> {
        await this.pool.query(
            `UPDATE crawler_jobs
             SET state = 'interrupted',
                 error = 'Crawl interrupted because its worker lease expired.',
                 updated_at = NOW(), completed_at = NOW(),
                 worker_id = NULL, lease_until = NULL
             WHERE state = 'running' AND lease_until < NOW()`
        );
    }

    private async pruneOldJobs(): Promise<void> {
        await this.pool.query(
            `DELETE FROM crawler_jobs
             WHERE state <> 'running'
               AND (
                   created_at < NOW() - INTERVAL '30 days'
                   OR id NOT IN (
                       SELECT id FROM crawler_jobs
                       WHERE state <> 'running'
                       ORDER BY created_at DESC
                       LIMIT 100
                   )
               )`
        );
    }
}

function mapJob(row: JobRow): CrawlJob {
    return {
        id: row.id,
        state: row.state,
        progress: row.progress,
        stats: row.stats,
        error: row.error,
        pages: row.pages,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}

function isUniqueViolation(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
    );
}

function assertUpdated(rowCount: number | null, id: string): void {
    if (rowCount !== 1) {
        throw new Error(`Running crawl job ${id} was not found`);
    }
}
