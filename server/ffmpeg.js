import { once } from 'node:events';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

function safeMessage(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(-600);
}

function waitForExit(child, stderrChunks) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) return resolve();
      const detail = safeMessage(Buffer.concat(stderrChunks).toString('utf8'));
      reject(new Error(`FFmpeg exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.${detail ? ` ${detail}` : ''}`));
    });
  });
}

function killProcess(child) {
  if (!child || child.exitCode !== null) return;
  try { child.kill('SIGTERM'); } catch {}
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2_000);
  timer.unref?.();
}

async function startFfmpeg(args, { signal } = {}) {
  const child = spawn(FFMPEG_PATH, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], {
    stdio: ['pipe', 'ignore', 'pipe']
  });
  const stderrChunks = [];
  child.stderr.on('data', chunk => {
    if (Buffer.concat(stderrChunks).length < 8_000) stderrChunks.push(Buffer.from(chunk));
  });
  const abort = () => killProcess(child);
  signal?.addEventListener('abort', abort, { once: true });
  const wait = waitForExit(child, stderrChunks).finally(() => signal?.removeEventListener('abort', abort));
  wait.catch(() => {});
  try {
    return { child, stderrChunks, wait };
  } catch (error) {
    signal?.removeEventListener('abort', abort);
    killProcess(child);
    throw error;
  }
}

export async function createPcmFlacEncoder(outputPath, { signal } = {}) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const partPath = `${outputPath}.part`;
  await rm(partPath, { force: true });
  const processState = await startFfmpeg([
    '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0',
    '-vn', '-c:a', 'flac', '-f', 'flac', partPath
  ], { signal });
  let finished = false;
  let abortError = null;
  const onAbort = () => { abortError = new Error('Audio job was cancelled.'); killProcess(processState.child); };
  signal?.addEventListener('abort', onAbort, { once: true });

  const write = async frame => {
    if (finished) throw new Error('The FFmpeg encoder is already closed.');
    if (abortError || signal?.aborted) throw abortError || new Error('Audio job was cancelled.');
    if (!Buffer.isBuffer(frame) || !frame.length || frame.length % 2) throw new Error('Invalid PCM frame.');
    if (!processState.child.stdin.write(frame)) await once(processState.child.stdin, 'drain');
  };
  const finish = async () => {
    if (finished) return;
    finished = true;
    try {
      if (abortError || signal?.aborted) throw abortError || new Error('Audio job was cancelled.');
      processState.child.stdin.end();
      await processState.wait;
      if (abortError || signal?.aborted) throw abortError || new Error('Audio job was cancelled.');
      await rename(partPath, outputPath);
      const details = await stat(outputPath);
      if (!details.size) throw new Error('FFmpeg returned an empty segment.');
      return details;
    } catch (error) {
      killProcess(processState.child);
      await rm(partPath, { force: true });
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  };
  const abort = () => {
    if (finished) return;
    abortError = new Error('Audio job was cancelled.');
    try { processState.child.stdin.destroy(abortError); } catch {}
    killProcess(processState.child);
  };
  return { write, finish, abort };
}

export async function finalizeSegments({ segmentPaths, outputPath, format, signal }) {
  if (!Array.isArray(segmentPaths) || !segmentPaths.length) throw new Error('No audio segments are available.');
  await mkdir(path.dirname(outputPath), { recursive: true });
  const listPath = `${outputPath}.concat.txt`;
  const partPath = `${outputPath}.part`;
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  await writeFile(listPath, segmentPaths.map(file => `file ${quote(file)}`).join('\n') + '\n', 'utf8');
  await rm(partPath, { force: true });
  try {
    const outputArgs = format === 'mp3'
      ? ['-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', partPath]
      : format === 'flac'
        ? ['-vn', '-c:a', 'flac', '-f', 'flac', partPath]
        : format === 'aac'
          ? ['-vn', '-c:a', 'aac', '-b:a', '192k', '-f', 'adts', partPath]
          : format === 'ogg'
            ? ['-vn', '-c:a', 'libvorbis', '-q:a', '5', '-f', 'ogg', partPath]
            : ['-vn', '-c:a', 'pcm_s16le', '-f', 'wav', partPath];
    const args = ['-f', 'concat', '-safe', '0', '-i', listPath, ...outputArgs];
    const processState = await startFfmpeg(args, { signal });
    await processState.wait;
    if (signal?.aborted) throw new Error('Audio job was cancelled.');
    await rename(partPath, outputPath);
    const details = await stat(outputPath);
    if (!details.size) throw new Error('FFmpeg returned an empty final file.');
    return details;
  } finally {
    await rm(listPath, { force: true });
    await rm(partPath, { force: true });
  }
}
