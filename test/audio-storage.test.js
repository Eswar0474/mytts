import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAudioStorage } from '../server/audio-storage.js';

test('audio storage keeps job keys inside its configured root', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sonora-audio-'));
  const storage = createAudioStorage(root);
  await storage.ensureJob('job_123');
  const key = storage.finalRelativeKey('job_123', 'mp3');
  const filePath = storage.pathForKey(key);
  await writeFile(filePath, Buffer.from('audio'));
  assert.equal((await storage.statKey(key)).size, 5);
  assert.match(filePath, new RegExp(`${root.replaceAll('\\', '\\\\')}.*final\\.mp3$`));
  assert.throws(() => storage.pathForKey('../outside.mp3'), /Invalid audio storage key/);
  assert.throws(() => storage.finalRelativeKey('../outside', 'mp3'), /Invalid audio job id/);
});
