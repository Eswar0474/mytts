export const AUDIO_FORMATS = Object.freeze({
  mp3: { label: 'MP3', extension: 'mp3', mimeType: 'audio/mpeg' },
  wav: { label: 'WAV', extension: 'wav', mimeType: 'audio/wav' },
  flac: { label: 'FLAC', extension: 'flac', mimeType: 'audio/flac' },
  aac: { label: 'AAC', extension: 'aac', mimeType: 'audio/aac' },
  ogg: { label: 'OGG', extension: 'ogg', mimeType: 'audio/ogg' }
});

export function isFormatAllowed(format, signedIn = false) {
  return Object.hasOwn(AUDIO_FORMATS, format) && (format === 'mp3' || signedIn === true);
}

export function transcodeArguments(format, inputName, outputName) {
  if (!Object.hasOwn(AUDIO_FORMATS, format)) throw new RangeError(`Unsupported audio format: ${format}`);
  if (format === 'mp3') return ['-i', inputName, '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', outputName];
  if (format === 'flac') return ['-i', inputName, '-vn', '-c:a', 'flac', outputName];
  if (format === 'aac') return ['-i', inputName, '-vn', '-c:a', 'aac', '-b:a', '192k', '-f', 'adts', outputName];
  if (format === 'ogg') return ['-i', inputName, '-vn', '-c:a', 'libvorbis', '-q:a', '5', '-f', 'ogg', outputName];
  return ['-i', inputName, '-vn', '-c:a', 'pcm_s16le', outputName];
}
