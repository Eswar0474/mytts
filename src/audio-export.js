import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';
import { AUDIO_FORMATS, transcodeArguments } from './audio-formats.js';
import { asError } from './export-errors.js';

export { AUDIO_FORMATS } from './audio-formats.js';

let ffmpegPromise;
let exportSequence = 0;
const ffmpegLog = [];

async function getFFmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const { FFmpeg } = await import('@ffmpeg/ffmpeg');
      const ffmpeg = new FFmpeg();
      ffmpeg.on('log', ({ message }) => {
        if (typeof message === 'string') {
          ffmpegLog.push(message);
          if (ffmpegLog.length > 40) ffmpegLog.shift();
        }
      });
      await ffmpeg.load({ coreURL, wasmURL });
      return ffmpeg;
    })();
  }
  try {
    return await ffmpegPromise;
  } catch (error) {
    ffmpegPromise = undefined;
    throw asError(error, 'The audio encoder could not be initialized.');
  }
}

/**
 * Transcode audio to the requested format.
 *
 * @param {Uint8Array} wavBytes  Complete WAV file bytes (from wavBytesRef).
 * @param {string}     format    One of the keys in AUDIO_FORMATS.
 * @returns {Promise<Uint8Array>}
 */
export async function transcodeAudio(wavBytes, format) {
  if (!(wavBytes instanceof Uint8Array) || !wavBytes.byteLength) throw new TypeError('A non-empty WAV file is required.');
  if (!Object.hasOwn(AUDIO_FORMATS, format)) throw new RangeError(`Unsupported audio format: ${format}`);
  if (format === 'wav') return wavBytes;

  const ffmpeg = await getFFmpeg();
  const sequence = ++exportSequence;
  const inputName = `sonora-input-${sequence}.wav`;
  const outputName = `sonora-output-${sequence}.${AUDIO_FORMATS[format].extension}`;
  ffmpegLog.length = 0;
  try {
    await ffmpeg.writeFile(inputName, wavBytes.slice());
    const exitCode = await ffmpeg.exec(transcodeArguments(format, inputName, outputName));
    if (exitCode !== 0) {
      const details = ffmpegLog.slice(-5).join(' ').slice(-500);
      throw new Error(`Audio conversion to ${AUDIO_FORMATS[format].label} failed.${details ? ` ${details}` : ''}`);
    }
    const result = await ffmpeg.readFile(outputName);
    if (!(result instanceof Uint8Array) || !result.byteLength) throw new Error('Audio conversion returned an empty file.');
    return result;
  } catch (error) {
    ffmpeg.terminate();
    ffmpegPromise = undefined;
    throw asError(error, `Audio conversion to ${AUDIO_FORMATS[format].label} failed.`);
  } finally {
    try { await ffmpeg.deleteFile(inputName); } catch {}
    try { await ffmpeg.deleteFile(outputName); } catch {}
  }
}
