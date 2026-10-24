import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { groupSpeechChunks } from '../server/job-worker.js';
import { publicJob } from '../server/job-store.js';
import { createAudioStorage } from '../server/audio-storage.js';
import { createJobWorker } from '../server/job-worker.js';

test('long-job worker groups bounded speech chunks without losing order', () => {
  const groups = groupSpeechChunks(['one two ', 'three four ', 'five six ', 'seven'], 4);
  assert.deepEqual(groups, [
    { start: 0, end: 2, text: 'one two three four ', words: 4 },
    { start: 2, end: 4, text: 'five six seven', words: 3 }
  ]);
});

test('public job metadata never exposes script text or storage paths', () => {
  const job = publicJob({
    id: 'job_123', user_id: 'local:1', title: 'Chapter 1', script_text: 'secret script',
    model: 'model', voice: 'Kore', output_format: 'mp3', status: 'completed',
    total_chunks: '10', completed_chunks: '10', total_audio_bytes: '123', duration_seconds: '4.2',
    storage_key: 'jobs/job_123/final.mp3', retry_count: '0', cancel_requested: false,
    created_at: '2026-10-24T00:00:00Z', updated_at: '2026-10-24T00:00:00Z'
  });
  assert.equal(job.progressPercent, 100);
  assert.equal(job.totalAudioBytes, 123);
  assert.equal(Object.hasOwn(job, 'script_text'), false);
  assert.equal(Object.hasOwn(job, 'storage_key'), false);
});

test('long-job worker persists progress and creates a final encoded file', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sonora-worker-test-'));
  try {
    const storage = createAudioStorage(root);
    const job = {
      id: 'job_worker-test', user_id: 'local:1', title: 'Test', script_text: 'one two three',
      model: 'model', voice: 'Kore', output_format: 'mp3', storage_key: 'jobs/job_worker-test/final.mp3',
      total_chunks: 3, completed_chunks: 0, total_audio_bytes: 0, duration_seconds: 0, retry_count: 0, cancel_requested: false
    };
    let claimed = false;
    let completed;
    const finished = new Promise(resolve => { completed = resolve; });
    const store = {
      async claimNextJob() { if (claimed) return null; claimed = true; return job; },
      async isCancelRequested() { return false; },
      async touch(_id, _token, progress) { Object.assign(job, { completed_chunks: progress.completedChunks, total_audio_bytes: progress.totalAudioBytes, duration_seconds: progress.durationSeconds }); },
      async complete(_id, _token, progress) { Object.assign(job, progress, { status: 'completed' }); completed(job); return job; },
      async requeue() { assert.fail('job should not requeue'); },
      async fail(_id, _token, error) { assert.fail(`job should not fail: ${error.errorCode}`); },
      async cancel() { assert.fail('job should not cancel'); }
    };
    const calls = [];
    const worker = createJobWorker({
      store, storage, models: [{ id: 'model', transport: 'live', wordLimit: 2 }],
      getSpeechChunks: () => ['one ', 'two ', 'three'],
      generate: async ({ text, onAudio }) => { calls.push(text); await onAudio(Buffer.alloc(48_000)); },
      pollIntervalMs: 20
    });
    worker.start();
    await finished;
    worker.stop();
    assert.deepEqual(calls, ['one two ', 'three']);
    assert.equal(job.completed_chunks, 3);
    assert.equal((await stat(storage.pathForKey(job.storage_key))).isFile(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
