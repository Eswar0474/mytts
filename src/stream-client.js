import { MAX_STREAM_WIRE_BYTES, SAMPLE_RATE, createNDJSONParser } from './audio.js';

export function isValidStreamStart(event) {
  return event?.type === 'start' && event.sampleRate === SAMPLE_RATE &&
    Number.isInteger(event.totalChunks) && event.totalChunks > 0;
}

/**
 * Consume an NDJSON response without cancelling a response that already
 * reached its natural EOF. Server-side synthesis failures are represented by
 * a terminal error event after the HTTP 200 headers have been sent, so the
 * caller must wait for EOF before surfacing that application-level error.
 */
export async function readNDJSONStream(reader, { onEvent, isActive = () => true } = {}) {
  if (!reader || typeof reader.read !== 'function') throw new TypeError('A readable stream reader is required.');
  if (typeof onEvent !== 'function') throw new TypeError('An event handler is required.');

  const decoder = new TextDecoder('utf-8', { fatal: true });
  let wireBytes = 0;
  let serverError;
  let ended = false;
  const parser = createNDJSONParser((event) => {
    if (serverError) throw new Error('Received an event after a stream error.');
    if (event.type === 'error') {
      serverError = new Error(typeof event.error === 'string' ? event.error : 'Generation failed.');
      return;
    }
    if (isActive()) onEvent(event);
  });

  while (true) {
    const result = await reader.read();
    if (result.done) {
      ended = true;
      break;
    }
    if (!result.value || !Number.isInteger(result.value.byteLength) || result.value.byteLength < 0) {
      throw new Error('Invalid streaming response chunk.');
    }
    wireBytes += result.value.byteLength;
    if (wireBytes > MAX_STREAM_WIRE_BYTES) throw new Error('Stream exceeds the wire safety limit.');
    parser.push(decoder.decode(result.value, { stream: true }));
  }

  parser.push(decoder.decode());
  parser.finish();
  return { ended, error: serverError };
}
