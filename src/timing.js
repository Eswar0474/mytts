// Rough pacing assumptions only: spoken words, character-heavy languages, and
// provider turns all contribute. No provider completion-time guarantee is made.
const PACING = Object.freeze({
  'gemini-2.5-flash-native-audio-preview-12-2025': { startup: 10, perChunk: 7, speech: 1 },
  'gemini-3.8-live': { startup: 15, perChunk: 10, speech: 1.2 },
  'gemini-3.8-live-extended-thinking': { startup: 22, perChunk: 14, speech: 1.5 }
});

export function estimateGenerationSeconds(requestText, modelId) {
  if (typeof requestText !== 'string' || !requestText.trim()) return 0;
  const words = requestText.match(/\S+/gu)?.length ?? 0;
  const turns = Math.max(Math.ceil(words / 100), Math.ceil(requestText.length / 500));
  const pacing = PACING[modelId] || PACING['gemini-2.5-flash-native-audio-preview-12-2025'];
  const speechSeconds = Math.max(words / 2.5, requestText.length / 12);
  return Math.ceil(pacing.startup + pacing.perChunk * turns + pacing.speech * speechSeconds);
}

export function formatApproximateDuration(seconds) {
  if (seconds <= 0) return '';
  if (seconds < 45) return 'under a minute';
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

export function formatElapsedTime(seconds) {
  const whole = Math.floor(Math.max(0, seconds));
  const minutes = Math.floor(whole / 60);
  const clock = `${String(minutes % 60).padStart(minutes >= 60 ? 2 : 1, '0')}:${String(whole % 60).padStart(2, '0')}`;
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${clock}` : clock;
}

export function getRequestTiming(request, now) {
  if (!request) return null;
  const active = request.finishedAt == null;
  const elapsedSeconds = Math.floor(Math.max(0, ((active ? now : request.finishedAt) - request.startedAt) / 1000));
  // Delay the overtime hint until the approximate displayed minute has elapsed.
  const approximateCeiling = Math.max(60, Math.ceil(request.estimateSeconds / 60) * 60);
  return { elapsedSeconds, takingLonger: active && elapsedSeconds > approximateCeiling };
}
