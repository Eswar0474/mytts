/**
 * audio-store.js
 *
 * IndexedDB-backed PCM audio store for Sonora.
 *
 * Each generation session gets a unique `sessionId` (monotonic counter).
 * PCM chunks are stored as individual records and read back in order when
 * building the final WAV.  The store is cleared at the start of each new
 * generation so stale data from cancelled or failed sessions never bleeds
 * through.
 *
 * Falls back to a plain in-memory array when IndexedDB is unavailable (e.g.
 * in tests or private-browsing environments that block IDB).
 */

const DB_NAME = 'sonora-audio';
const DB_VERSION = 1;
const STORE_NAME = 'pcm-chunks';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this environment.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        // Compound key: [sessionId, chunkIndex] gives us natural ordering
        db.createObjectStore(STORE_NAME, { keyPath: ['sessionId', 'chunkIndex'] });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Create a session-scoped audio store.
 *
 * @param {number} sessionId  Unique ID for this generation run.
 * @returns {AudioStore}
 */
export function createAudioStore(sessionId) {
  // --- in-memory fallback state ---
  let memChunks = [];
  let memBytes = 0;
  let usingMemory = false;
  let chunkIndex = 0;
  let totalBytes = 0;
  let pendingWrite = Promise.resolve();

  /**
   * Append a raw PCM Uint8Array chunk, persisting it to IndexedDB.
   * Falls back to memory on any IDB error.
   */
  function appendChunk(pcm) {
    totalBytes += pcm.byteLength;
    const index = chunkIndex++;

    // The NDJSON parser receives events synchronously, while IndexedDB writes
    // are asynchronous. Queue writes here so buildWav/streamChunks can wait
    // for every chunk even when callers intentionally fire-and-forget.
    pendingWrite = pendingWrite.then(async () => {
      if (usingMemory) {
        memChunks.push(pcm);
        memBytes += pcm.byteLength;
        return;
      }

      try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        await idbRequest(tx.objectStore(STORE_NAME).put({
          sessionId,
          chunkIndex: index,
          pcm: pcm.slice() // detach from any shared buffer
        }));
      } catch {
        // IDB unavailable — switch to memory for remaining chunks
        usingMemory = true;
        memChunks.push(pcm);
        memBytes += pcm.byteLength;
      }
    });
    return pendingWrite;
  }

  /**
   * Read stored chunks and build one complete WAV Uint8Array.
   * IndexedDB helps during receipt, but getAll() and final assembly still
   * materialize the audio in memory; this is not a disk-streaming WAV writer.
   */
  async function buildWav(sampleRate = 24000) {
    if (!totalBytes) throw new Error('The stream returned no audio.');
    await pendingWrite;
    const WAV_HEADER_BYTES = 44;

    if (usingMemory) {
      // The fallback also assembles a full WAV. Server/transport caps still apply.
      const wav = new Uint8Array(WAV_HEADER_BYTES + memBytes);
      const view = new DataView(wav.buffer);
      writeWavHeader(view, wav, memBytes, sampleRate);
      let offset = WAV_HEADER_BYTES;
      for (const chunk of memChunks) { wav.set(chunk, offset); offset += chunk.byteLength; }
      return wav;
    }

    try {
      const db = await openDB();
      const tx = db.transaction(STORE_NAME, 'readonly');
      const range = IDBKeyRange.bound([sessionId, 0], [sessionId, chunkIndex]);
      const records = await idbRequest(tx.objectStore(STORE_NAME).getAll(range));

      const pcmSize = records.reduce((acc, r) => acc + r.pcm.byteLength, 0);
      const wav = new Uint8Array(WAV_HEADER_BYTES + pcmSize);
      const view = new DataView(wav.buffer);
      writeWavHeader(view, wav, pcmSize, sampleRate);
      let offset = WAV_HEADER_BYTES;
      for (const record of records) { wav.set(record.pcm, offset); offset += record.pcm.byteLength; }
      return wav;
    } catch {
      // IDB read failed after we were writing to IDB — shouldn't happen but
      // fall back to returning whatever is in memChunks (likely empty = error)
      throw new Error('Could not read audio from IndexedDB. Please retry.');
    }
  }

  /**
   * Stream all IDB chunks sequentially into a callback.
   * Available for a future incremental consumer. The current audio-export.js
   * path takes a complete WAV and does not call this helper.
   *
   * @param {(chunk: Uint8Array) => void} onChunk
   */
  async function streamChunks(onChunk) {
    await pendingWrite;
    if (usingMemory) {
      for (const chunk of memChunks) onChunk(chunk);
      return;
    }
    try {
      const db = await openDB();
      const tx = db.transaction(STORE_NAME, 'readonly');
      const range = IDBKeyRange.bound([sessionId, 0], [sessionId, chunkIndex]);
      const store = tx.objectStore(STORE_NAME);
      await new Promise((resolve, reject) => {
        const cursorReq = store.openCursor(range);
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) { resolve(); return; }
          try { onChunk(cursor.value.pcm); cursor.continue(); }
          catch (err) { reject(err); }
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      });
    } catch (err) {
      if (usingMemory) { for (const chunk of memChunks) onChunk(chunk); return; }
      throw err;
    }
  }

  /**
   * Delete all records for this session from IndexedDB.
   * Call after the WAV has been assembled / export is complete.
   */
  async function clear() {
    try { await pendingWrite; } catch { /* best-effort */ }
    memChunks = [];
    memBytes = 0;
    if (usingMemory) return;
    try {
      const db = await openDB();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const range = IDBKeyRange.bound([sessionId, 0], [sessionId, chunkIndex]);
      await idbRequest(tx.objectStore(STORE_NAME).delete(range));
    } catch { /* best-effort */ }
  }

  return { appendChunk, buildWav, streamChunks, clear, get totalBytes() { return totalBytes; } };
}

// --- WAV header writer (no external dep) ---
function writeWavHeader(view, wav, pcmSize, sampleRate) {
  const write = (offset, value) => {
    for (let i = 0; i < value.length; i++) wav[offset + i] = value.charCodeAt(i);
  };
  write(0, 'RIFF'); view.setUint32(4, pcmSize + 36, true);
  write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true);  // chunk size
  view.setUint16(20, 1, true);   // PCM
  view.setUint16(22, 1, true);   // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);   // block align
  view.setUint16(34, 16, true);  // bits per sample
  write(36, 'data'); view.setUint32(40, pcmSize, true);
}

/**
 * Monotonic session ID generator — safe even if called very quickly.
 */
let _sessionCounter = 0;
export function nextSessionId() {
  return ++_sessionCounter;
}
