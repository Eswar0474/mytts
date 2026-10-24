import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createPcmFlacEncoder, finalizeSegments } from '../server/ffmpeg.js';

const hasFfmpeg = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

test('native FFmpeg encodes bounded PCM segments and finalizes supported formats', { skip: !hasFfmpeg }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sonora-ffmpeg-test-'));
  try {
    const segments = [];
    for (let index = 0; index < 2; index++) {
      const segmentPath = path.join(root, `segment-${index}.flac`);
      const encoder = await createPcmFlacEncoder(segmentPath);
      await encoder.write(Buffer.alloc(48_000));
      await encoder.finish();
      segments.push(segmentPath);
    }
    for (const format of ['mp3', 'wav', 'flac', 'aac', 'ogg']) {
      const outputPath = path.join(root, `final-${format}.${format}`);
      const details = await finalizeSegments({ segmentPaths: segments, outputPath, format });
      assert.ok(details.size > 0, format);
      assert.equal((await stat(outputPath)).isFile(), true, format);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
