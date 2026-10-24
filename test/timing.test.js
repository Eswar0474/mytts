import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateGenerationSeconds, formatApproximateDuration, formatElapsedTime, getRequestTiming } from '../src/timing.js';

const low = 'gemini-2.5-flash-native-audio-preview-12-2025';
const balanced = 'gemini-3.8-live';
const enhanced = 'gemini-3.8-live-extended-thinking';

test('empty input has no estimate; larger scripts and heavier models grow the estimate', () => {
  assert.equal(estimateGenerationSeconds('', low), 0);
  assert.equal(estimateGenerationSeconds('   \n', balanced), 0);
  const short = estimateGenerationSeconds('Hello there.', low);
  const long = estimateGenerationSeconds('Hello there. '.repeat(120), low);
  assert.ok(short > 0);
  assert.ok(long > short);
  assert.ok(estimateGenerationSeconds('Hello there.', balanced) > short);
  assert.ok(estimateGenerationSeconds('Hello there.', enhanced) > estimateGenerationSeconds('Hello there.', balanced));
});

test('character-heavy language and long uninterrupted tokens add provider turns despite low word counts', () => {
  const short = estimateGenerationSeconds('नमस्ते', low);
  const hindi = estimateGenerationSeconds('नमस्ते'.repeat(150), low);
  const oneLongToken = estimateGenerationSeconds('あ'.repeat(1250), low);
  assert.ok(hindi > short);
  assert.ok(oneLongToken > estimateGenerationSeconds('あ'.repeat(450), low));
});

test('clock formatting, reset, active overtime, and final elapsed snapshot', () => {
  assert.equal(formatElapsedTime(0), '0:00');
  assert.equal(formatElapsedTime(61), '1:01');
  assert.equal(formatElapsedTime(3661), '1:01:01');
  assert.equal(formatApproximateDuration(0), '');
  assert.equal(formatApproximateDuration(25), 'under a minute');
  assert.match(formatApproximateDuration(150), /minutes/);
  assert.equal(getRequestTiming(null, 10_000), null);
  const request = { startedAt: 100_000, finishedAt: null, estimateSeconds: 30 };
  assert.deepEqual(getRequestTiming(request, 125_000), { elapsedSeconds: 25, takingLonger: false });
  assert.deepEqual(getRequestTiming(request, 131_000), { elapsedSeconds: 31, takingLonger: false });
  assert.deepEqual(getRequestTiming(request, 161_000), { elapsedSeconds: 61, takingLonger: true });
  const stopped = { ...request, finishedAt: 142_500 };
  assert.deepEqual(getRequestTiming(stopped, 200_000), { elapsedSeconds: 42, takingLonger: false });
  const freshRequest = { startedAt: 200_000, finishedAt: null, estimateSeconds: 50 };
  assert.deepEqual(getRequestTiming(freshRequest, 200_000), { elapsedSeconds: 0, takingLonger: false });
});
