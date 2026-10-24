import test from 'node:test';
import assert from 'node:assert/strict';
import { readNDJSONStream } from '../src/stream-client.js';

function readerFor(lines) {
  let index = 0;
  let cancelled = false;
  return {
    async read() {
      if (index >= lines.length) return { done: true, value: undefined };
      return { done: false, value: new TextEncoder().encode(lines[index++]) };
    },
    async cancel() { cancelled = true; },
    get cancelled() { return cancelled; }
  };
}

test('server terminal errors are reported after natural NDJSON EOF', async () => {
  const reader = readerFor([
    '{"type":"start"}\n',
    '{"type":"error","error":"Gemini audio generation failed; the audio is incomplete."}\n'
  ]);
  const events = [];
  const result = await readNDJSONStream(reader, { onEvent: event => events.push(event) });

  assert.equal(result.ended, true);
  assert.equal(result.error?.message, 'Gemini audio generation failed; the audio is incomplete.');
  assert.deepEqual(events.map(event => event.type), ['start']);
  assert.equal(reader.cancelled, false);
});

test('active stream events remain available to the application handler', async () => {
  const reader = readerFor(['{"type":"start"}\n{"type":"done"}\n']);
  const events = [];
  const result = await readNDJSONStream(reader, { onEvent: event => events.push(event) });

  assert.equal(result.ended, true);
  assert.equal(result.error, undefined);
  assert.deepEqual(events.map(event => event.type), ['start', 'done']);
});
