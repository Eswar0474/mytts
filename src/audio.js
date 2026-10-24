export const SAMPLE_RATE = 24000;
export const MAX_AUDIO_BYTES = 128 * 1024 * 1024;
// NDJSON contains base64 audio plus event framing, so its safe wire budget is
// intentionally separate from the decoded PCM budget.
export const MAX_STREAM_WIRE_BYTES = Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 4 * 1024 * 1024;

const base64Value = (code) => {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
};

/** Decode mono signed 16-bit little-endian PCM without relying on host endianness. */
export function decodeBase64PCM(data, maxBytes = MAX_AUDIO_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2 || typeof data !== 'string' || !data.length || data.length % 4 !== 0 ||
      data.length > Math.ceil(maxBytes / 3) * 4) {
    throw new Error('Invalid base64 PCM audio.');
  }
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const payloadLength = data.length - padding;
  for (let index = 0; index < payloadLength; index++) {
    if (base64Value(data.charCodeAt(index)) < 0) throw new Error('Invalid base64 PCM audio.');
  }
  for (let index = payloadLength; index < data.length; index++) {
    if (data[index] !== '=') throw new Error('Invalid base64 PCM audio.');
  }
  if (padding === 2 && (base64Value(data.charCodeAt(payloadLength - 1)) & 0x0f) !== 0) {
    throw new Error('Invalid base64 PCM audio.');
  }
  if (padding === 1 && (base64Value(data.charCodeAt(payloadLength - 1)) & 0x03) !== 0) {
    throw new Error('Invalid base64 PCM audio.');
  }
  const decodedLength = (data.length / 4) * 3 - padding;
  if (!decodedLength || decodedLength > maxBytes || decodedLength % 2) throw new Error('PCM audio must contain complete 16-bit samples.');
  let binary;
  try { binary = atob(data); } catch { throw new Error('Invalid base64 PCM audio.'); }
  if (binary.length !== decodedLength) throw new Error('Invalid base64 PCM audio.');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function pcmToFloat32(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength % 2) throw new Error('Invalid PCM samples.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(bytes.byteLength / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  return samples;
}

/** Return WAV bytes; caller can wrap these in an audio/wav Blob. */
export function encodeWav(chunks, sampleRate = SAMPLE_RATE, maxBytes = MAX_AUDIO_BYTES) {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate > 192000) throw new Error('Invalid sample rate.');
  let size = 0;
  for (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array) || chunk.byteLength % 2) throw new Error('Invalid PCM samples.');
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error('Audio exceeds the 128 MiB safety limit.');
  }
  if (!size) throw new Error('The stream returned no audio.');
  const wav = new Uint8Array(44 + size);
  const view = new DataView(wav.buffer);
  const write = (offset, value) => { for (let i = 0; i < value.length; i++) wav[offset + i] = value.charCodeAt(i); };
  write(0, 'RIFF'); view.setUint32(4, size + 36, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, size, true);
  let offset = 44;
  for (const chunk of chunks) { wav.set(chunk, offset); offset += chunk.byteLength; }
  return wav;
}

/** Incremental NDJSON parser: accepts arbitrary text boundaries and a final unterminated line. */
export function createNDJSONParser(onEvent, maxBytes = MAX_STREAM_WIRE_BYTES) {
  let pending = '';
  let received = 0;
  const parse = (line) => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { throw new Error('Invalid NDJSON response.'); }
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') throw new Error('Invalid stream event.');
    onEvent(event);
  };
  return {
    push(text) {
      received += new TextEncoder().encode(text).byteLength;
      if (received > maxBytes) throw new Error('Stream exceeds the wire safety limit.');
      pending += text;
      let start = 0;
      let end;
      while ((end = pending.indexOf('\n', start)) !== -1) { parse(pending.slice(start, end)); start = end + 1; }
      pending = pending.slice(start);
    },
    finish() { parse(pending); pending = ''; }
  };
}
