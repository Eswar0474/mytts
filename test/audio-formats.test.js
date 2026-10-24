import test from 'node:test';
import assert from 'node:assert/strict';
import { AUDIO_FORMATS, transcodeArguments, isFormatAllowed } from '../src/audio-formats.js';

test('audio export formats map to named files and supported encoder arguments', () => {
  assert.deepEqual(Object.keys(AUDIO_FORMATS), ['mp3', 'wav', 'flac', 'aac', 'ogg']);
  assert.equal(AUDIO_FORMATS.mp3.mimeType, 'audio/mpeg');
  assert.deepEqual(transcodeArguments('mp3', 'in.wav', 'out.mp3'), [
    '-i', 'in.wav', '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', 'out.mp3'
  ]);
  assert.deepEqual(transcodeArguments('flac', 'in.wav', 'out.flac'), [
    '-i', 'in.wav', '-vn', '-c:a', 'flac', 'out.flac'
  ]);
  assert.deepEqual(transcodeArguments('aac', 'in.wav', 'out.aac'), [
    '-i', 'in.wav', '-vn', '-c:a', 'aac', '-b:a', '192k', '-f', 'adts', 'out.aac'
  ]);
  assert.deepEqual(transcodeArguments('ogg', 'in.wav', 'out.ogg'), [
    '-i', 'in.wav', '-vn', '-c:a', 'libvorbis', '-q:a', '5', '-f', 'ogg', 'out.ogg'
  ]);
  assert.throws(() => transcodeArguments('unknown', 'in.wav', 'out'), /Unsupported audio format/);
});

test('guests get MP3, signed-in users get all known audio formats', () => {
  for (const format of Object.keys(AUDIO_FORMATS)) {
    assert.equal(isFormatAllowed(format, false), format === 'mp3');
    assert.equal(isFormatAllowed(format, true), true);
  }
  assert.equal(isFormatAllowed('mp3'), true);
  assert.equal(isFormatAllowed('unknown', false), false);
  assert.equal(isFormatAllowed('unknown', true), false);
  assert.equal(isFormatAllowed('__proto__', true), false);
});
