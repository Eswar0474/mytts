import { randomUUID } from 'node:crypto';

export const JOB_STATUSES = Object.freeze(['queued', 'running', 'completed', 'failed', 'cancelled']);
export const ACTIVE_JOB_STATUSES = Object.freeze(['queued', 'running']);

const jobColumns = `
  id, user_id, title, model, voice, output_format,
  status, total_chunks, completed_chunks, total_audio_bytes,
  duration_seconds, storage_key, error_code, error_message,
  retry_count, cancel_requested, worker_token, heartbeat_at,
  created_at, started_at, completed_at, updated_at
`;

const workerJobColumns = `
  id, user_id, title, script_text, model, voice, output_format,
  status, total_chunks, completed_chunks, total_audio_bytes,
  duration_seconds, storage_key, error_code, error_message,
  retry_count, cancel_requested, worker_token, heartbeat_at,
  created_at, started_at, completed_at, updated_at
`;

function mapJob(row) {
  if (!row) return null;
  return {
    ...row,
    total_chunks: Number(row.total_chunks),
    completed_chunks: Number(row.completed_chunks),
    total_audio_bytes: row.total_audio_bytes == null ? 0 : Number(row.total_audio_bytes),
    duration_seconds: row.duration_seconds == null ? 0 : Number(row.duration_seconds),
    retry_count: Number(row.retry_count || 0),
    cancel_requested: Boolean(row.cancel_requested)
  };
}

export function publicJob(row) {
  const job = mapJob(row) || row;
  if (!job) return null;
  const total = Number(job.total_chunks || 0);
  const completed = Math.min(total, Number(job.completed_chunks || 0));
  return {
    id: job.id,
    title: job.title,
    model: job.model,
    voice: job.voice,
    outputFormat: job.output_format,
    status: job.status,
    totalChunks: total,
    completedChunks: completed,
    progressPercent: total ? Math.round((completed / total) * 100) : 0,
    totalAudioBytes: Number(job.total_audio_bytes || 0),
    durationSeconds: Number(job.duration_seconds || 0),
    errorCode: job.error_code || null,
    errorMessage: job.error_message || null,
    retryCount: Number(job.retry_count || 0),
    cancelRequested: Boolean(job.cancel_requested),
    createdAt: job.created_at,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    updatedAt: job.updated_at
  };
}

export function createPostgresJobStore({ pool, ready = Promise.resolve(), logger = console, staleAfterMs = 120_000 }) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool is required for durable jobs.');
  }
  const waitReady = () => Promise.resolve(ready);

  async function createJob({
    id = `job_${randomUUID()}`,
    userId,
    title,
    scriptText,
    model,
    voice,
    outputFormat,
    totalChunks,
    storageKey
  }) {
    await waitReady();
    try {
      const result = await pool.query(
        `INSERT INTO audio_jobs
          (id, user_id, title, script_text, model, voice, output_format,
           status, total_chunks, completed_chunks, total_audio_bytes,
           duration_seconds, storage_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, 0, 0, 0, $9)
         RETURNING ${jobColumns}`,
        [id, userId, title, scriptText, model, voice, outputFormat, totalChunks, storageKey]
      );
      return mapJob(result.rows[0]);
    } catch (error) {
      if (error?.code === '23505') {
        const active = new Error('ACTIVE_JOB_LIMIT');
        active.code = 'ACTIVE_JOB_LIMIT';
        throw active;
      }
      throw error;
    }
  }

  async function listJobs(userId, limit = 50) {
    await waitReady();
    const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    const result = await pool.query(
      `SELECT ${jobColumns}
         FROM audio_jobs
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [userId, boundedLimit]
    );
    return result.rows.map(mapJob);
  }

  async function getJobForUser(userId, jobId) {
    await waitReady();
    const result = await pool.query(
      `SELECT ${jobColumns} FROM audio_jobs WHERE id = $1 AND user_id = $2`,
      [jobId, userId]
    );
    return mapJob(result.rows[0]);
  }

  async function countActiveJobs(userId) {
    await waitReady();
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count FROM audio_jobs
        WHERE user_id = $1 AND status IN ('queued', 'running')`,
      [userId]
    );
    return Number(result.rows[0]?.count || 0);
  }

  async function requestCancel(userId, jobId) {
    await waitReady();
    const result = await pool.query(
      `UPDATE audio_jobs
          SET cancel_requested = TRUE,
              status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
              updated_at = NOW()
        WHERE id = $1 AND user_id = $2 AND status IN ('queued', 'running')
      RETURNING ${jobColumns}`,
      [jobId, userId]
    );
    return mapJob(result.rows[0]);
  }

  async function claimNextJob(workerToken) {
    await waitReady();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT ${workerJobColumns}
           FROM audio_jobs
          WHERE (status = 'queued' AND cancel_requested = FALSE)
             OR (status = 'running' AND heartbeat_at < NOW() - ($1 * INTERVAL '1 millisecond'))
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
        [staleAfterMs]
      );
      const row = result.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return null;
      }
      const claimed = await client.query(
        `UPDATE audio_jobs
            SET status = 'running', worker_token = $2, heartbeat_at = NOW(),
                started_at = COALESCE(started_at, NOW()), updated_at = NOW()
          WHERE id = $1
        RETURNING ${workerJobColumns}`,
        [row.id, workerToken]
      );
      await client.query('COMMIT');
      return mapJob(claimed.rows[0]);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      logger.error?.('[sonora] Could not claim audio job', { name: error instanceof Error ? error.name : 'UnknownError' });
      throw error;
    } finally {
      client.release();
    }
  }

  async function isCancelRequested(jobId, workerToken) {
    await waitReady();
    const result = await pool.query(
      `SELECT cancel_requested FROM audio_jobs WHERE id = $1 AND worker_token = $2`,
      [jobId, workerToken]
    );
    return Boolean(result.rows[0]?.cancel_requested);
  }

  async function touch(jobId, workerToken, { completedChunks, totalAudioBytes, durationSeconds } = {}) {
    await waitReady();
    const result = await pool.query(
      `UPDATE audio_jobs
          SET heartbeat_at = NOW(), updated_at = NOW(),
              completed_chunks = COALESCE($3, completed_chunks),
              total_audio_bytes = COALESCE($4, total_audio_bytes),
              duration_seconds = COALESCE($5, duration_seconds)
        WHERE id = $1 AND worker_token = $2 AND status = 'running'
      RETURNING ${jobColumns}`,
      [jobId, workerToken, completedChunks ?? null, totalAudioBytes ?? null, durationSeconds ?? null]
    );
    return mapJob(result.rows[0]);
  }

  async function complete(jobId, workerToken, { storageKey, fileSizeBytes, durationSeconds, totalAudioBytes }) {
    await waitReady();
    const result = await pool.query(
      `UPDATE audio_jobs
          SET status = 'completed', completed_chunks = total_chunks,
              storage_key = $3, total_audio_bytes = $4,
              duration_seconds = $5, error_code = NULL, error_message = NULL,
              heartbeat_at = NULL, completed_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND worker_token = $2 AND status = 'running'
      RETURNING ${jobColumns}`,
      [jobId, workerToken, storageKey, fileSizeBytes ?? totalAudioBytes ?? 0, durationSeconds ?? 0]
    );
    return mapJob(result.rows[0]);
  }

  async function requeue(jobId, workerToken, { errorCode, errorMessage }) {
    await waitReady();
    const result = await pool.query(
      `UPDATE audio_jobs
          SET status = 'queued', retry_count = retry_count + 1,
              error_code = $3, error_message = $4,
              heartbeat_at = NULL, worker_token = NULL, updated_at = NOW()
        WHERE id = $1 AND worker_token = $2 AND status = 'running'
      RETURNING ${jobColumns}`,
      [jobId, workerToken, errorCode || 'JOB_RETRY', String(errorMessage || 'The job will retry.').slice(0, 500)]
    );
    return mapJob(result.rows[0]);
  }

  async function fail(jobId, workerToken, { errorCode, errorMessage }) {
    await waitReady();
    const result = await pool.query(
      `UPDATE audio_jobs
          SET status = 'failed', error_code = $3, error_message = $4,
              heartbeat_at = NULL, worker_token = NULL, updated_at = NOW()
        WHERE id = $1 AND worker_token = $2 AND status = 'running'
      RETURNING ${jobColumns}`,
      [jobId, workerToken, errorCode || 'JOB_FAILED', String(errorMessage || 'Audio generation failed.').slice(0, 500)]
    );
    return mapJob(result.rows[0]);
  }

  async function cancel(jobId, workerToken) {
    await waitReady();
    const result = await pool.query(
      `UPDATE audio_jobs
          SET status = 'cancelled', heartbeat_at = NULL, worker_token = NULL,
              updated_at = NOW()
        WHERE id = $1 AND worker_token = $2 AND status = 'running'
      RETURNING ${jobColumns}`,
      [jobId, workerToken]
    );
    return mapJob(result.rows[0]);
  }

  return {
    createJob,
    listJobs,
    getJobForUser,
    countActiveJobs,
    requestCancel,
    claimNextJob,
    isCancelRequested,
    touch,
    complete,
    requeue,
    fail,
    cancel
  };
}
