import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { createPcmFlacEncoder, finalizeSegments } from './ffmpeg.js';

const PCM_BYTES_PER_SECOND = 24_000 * 2;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_CANCEL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_OUTPUT_SECONDS = 5 * 60 * 60;

function countWords(value) {
  return value.match(/\S+/gu)?.length ?? 0;
}

export function groupSpeechChunks(chunks, maxWords) {
  if (!Array.isArray(chunks) || !chunks.length) return [];
  const groups = [];
  let start = 0;
  let text = '';
  let words = 0;
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    const chunkWords = countWords(chunk);
    if (text && words + chunkWords > maxWords) {
      groups.push({ start, end: index, text, words });
      start = index;
      text = '';
      words = 0;
    }
    text += chunk;
    words += chunkWords;
  }
  if (text) groups.push({ start, end: chunks.length, text, words });
  return groups;
}

function safeWorkerError(error) {
  const code = typeof error?.code === 'string' ? error.code : 'JOB_PROVIDER_ERROR';
  return { code: code.slice(0, 80), message: 'Audio generation could not complete this segment.' };
}

export function createJobWorker({
  store,
  storage,
  generate,
  models,
  getSpeechChunks,
  logger = console,
  concurrency = 1,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  cancelIntervalMs = DEFAULT_CANCEL_INTERVAL_MS,
  maxRetries = 3,
  maxOutputSeconds = DEFAULT_MAX_OUTPUT_SECONDS
}) {
  if (!store || !storage || typeof generate !== 'function' || !Array.isArray(models) || typeof getSpeechChunks !== 'function') {
    throw new TypeError('A job store, audio storage, synthesizer, model catalog, and chunker are required.');
  }
  const limit = Math.max(1, Number(concurrency) || 1);
  let stopped = true;
  let running = 0;
  let timer;
  const controllers = new Set();

  async function cleanupSegments(jobId) {
    await rm(path.join(storage.jobDirectory(jobId), 'segments'), { recursive: true, force: true });
  }

  async function runJob(job, workerToken) {
    const controller = new AbortController();
    controllers.add(controller);
    let heartbeatTimer;
    let cancelTimer;
    let completedChunks = Number(job.completed_chunks || 0);
    let totalAudioBytes = Number(job.total_audio_bytes || 0);
    let durationSeconds = Number(job.duration_seconds || 0);
    try {
      const selectedModel = models.find(model => model.id === job.model);
      if (!selectedModel || !job.voice || typeof job.script_text !== 'string') throw new Error('Invalid queued audio job.');
      const speechChunks = getSpeechChunks(job.script_text);
      const batches = groupSpeechChunks(speechChunks, selectedModel.wordLimit);
      if (!batches.length || completedChunks > speechChunks.length) throw new Error('Queued audio job has invalid progress.');
      await storage.ensureJob(job.id);
      heartbeatTimer = setInterval(() => {
        void store.touch(job.id, workerToken, { completedChunks, totalAudioBytes, durationSeconds }).catch(error => {
          logger.error?.('[sonora] Audio job heartbeat failed', { name: error instanceof Error ? error.name : 'UnknownError' });
        });
      }, heartbeatIntervalMs);
      heartbeatTimer.unref?.();
      cancelTimer = setInterval(() => {
        void store.isCancelRequested(job.id, workerToken).then(cancelled => {
          if (cancelled) controller.abort();
        }).catch(() => {});
      }, cancelIntervalMs);
      cancelTimer.unref?.();

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        if (batch.end <= completedChunks) continue;
        if (controller.signal.aborted || await store.isCancelRequested(job.id, workerToken)) {
          controller.abort();
          throw Object.assign(new Error('Audio job cancelled.'), { code: 'JOB_CANCELLED' });
        }
        const segmentPath = path.join(storage.segmentsDirectory(job.id), `${String(batchIndex).padStart(8, '0')}.flac`);
        await rm(segmentPath, { force: true });
        await rm(`${segmentPath}.part`, { force: true });
        const encoder = await createPcmFlacEncoder(segmentPath, { signal: controller.signal });
        let batchBytes = 0;
        try {
          await generate({
            text: batch.text,
            model: selectedModel.id,
            transport: selectedModel.transport,
            voice: job.voice,
            signal: controller.signal,
            onAudio: async frame => {
              batchBytes += frame.length;
              await encoder.write(frame);
            }
          });
          await encoder.finish();
        } catch (error) {
          encoder.abort();
          throw error;
        }
        if (!batchBytes) throw new Error('The provider returned no audio for a completed segment.');
        completedChunks = batch.end;
        totalAudioBytes += batchBytes;
        durationSeconds = totalAudioBytes / PCM_BYTES_PER_SECOND;
        if (durationSeconds > maxOutputSeconds) {
          throw Object.assign(new Error('The requested audio exceeds the maximum output duration.'), { code: 'JOB_OUTPUT_LIMIT' });
        }
        await store.touch(job.id, workerToken, { completedChunks, totalAudioBytes, durationSeconds });
      }

      if (controller.signal.aborted || await store.isCancelRequested(job.id, workerToken)) {
        controller.abort();
        throw Object.assign(new Error('Audio job cancelled.'), { code: 'JOB_CANCELLED' });
      }
      const segmentPaths = batches.map((_, index) => path.join(storage.segmentsDirectory(job.id), `${String(index).padStart(8, '0')}.flac`));
      const finalKey = job.storage_key;
      const finalPath = storage.pathForKey(finalKey);
      const details = await finalizeSegments({ segmentPaths, outputPath: finalPath, format: job.output_format, signal: controller.signal });
      await store.complete(job.id, workerToken, {
        storageKey: finalKey,
        fileSizeBytes: details.size,
        durationSeconds,
        totalAudioBytes
      });
      await cleanupSegments(job.id);
    } catch (error) {
      const cancelled = error?.code === 'JOB_CANCELLED' || controller.signal.aborted || await store.isCancelRequested(job.id, workerToken).catch(() => false);
      await rm(storage.pathForKey(job.storage_key), { force: true }).catch(() => {});
      if (cancelled) {
        await storage.removeJob(job.id).catch(() => {});
        await store.cancel(job.id, workerToken).catch(() => {});
      } else {
        const safe = safeWorkerError(error);
        if (error?.code === 'JOB_OUTPUT_LIMIT') {
          await cleanupSegments(job.id).catch(() => {});
          await store.fail(job.id, workerToken, safe).catch(failError => {
            logger.error?.('[sonora] Could not fail oversized audio job', { name: failError instanceof Error ? failError.name : 'UnknownError' });
          });
        } else if (Number(job.retry_count || 0) < maxRetries) {
          await store.requeue(job.id, workerToken, safe).catch(requeueError => {
            logger.error?.('[sonora] Could not requeue audio job', { name: requeueError instanceof Error ? requeueError.name : 'UnknownError' });
          });
        } else {
          await cleanupSegments(job.id).catch(() => {});
          await store.fail(job.id, workerToken, safe).catch(failError => {
            logger.error?.('[sonora] Could not fail audio job', { name: failError instanceof Error ? failError.name : 'UnknownError' });
          });
        }
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (cancelTimer) clearInterval(cancelTimer);
      controllers.delete(controller);
    }
  }

  async function pump() {
    if (stopped) return;
    while (running < limit) {
      const workerToken = `worker:${randomUUID()}`;
      let job;
      try { job = await store.claimNextJob(workerToken); }
      catch (error) {
        logger.error?.('[sonora] Audio job claim failed', { name: error instanceof Error ? error.name : 'UnknownError' });
        return;
      }
      if (!job) return;
      running++;
      void runJob(job, workerToken).catch(error => {
        logger.error?.('[sonora] Unexpected audio worker failure', { name: error instanceof Error ? error.name : 'UnknownError' });
      }).finally(() => {
        running--;
        void pump();
      });
    }
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    void pump();
    timer = setInterval(() => void pump(), pollIntervalMs);
    timer.unref?.();
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    for (const controller of controllers) controller.abort();
  }

  return { start, stop, pump, get running() { return running; } };
}
