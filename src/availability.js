export function getAvailability({
  configStatus, configured, voices = [], generating, selectedModel, voice, text,
  overWordLimit, overCharacterLimit, signedIn, wordLimit, longJobsEnabled
}) {
  const voiceDisabled = generating || configStatus !== 'ready' || !voices.length;
  let reason = '';
  if (generating) reason = 'Generation is in progress.';
  else if (configStatus === 'loading') reason = 'Checking server configuration…';
  else if (configStatus !== 'ready') reason = 'Cannot reach a valid server configuration. Retry configuration above.';
  else if (!configured) reason = 'Backend setup required: set GEMINI_API_KEY in the project’s .env file, verify the model setting, restart the backend, then click Retry configuration. Do not enter your key here.';
  else if (!selectedModel || !voice) reason = 'Select an engine and voice.';
  else if (selectedModel.requiresLogin && !signedIn) reason = 'Sign in to use this engine.';
  else if (!longJobsEnabled && Number.isFinite(wordLimit) && overWordLimit) reason = signedIn
    ? `Shorten your request to ${wordLimit.toLocaleString()} words for this engine (including tags).`
    : `Guests can submit up to ${wordLimit.toLocaleString()} words per request (including tags). Shorten your script or sign in for a higher limit.`;
  else if (overCharacterLimit) reason = 'Character safety limit reached. Shorten your script to fit this engine’s character cap.';
  else if (!text.trim()) reason = 'Write your script or click Use sample to enable generation.';
  return { voiceDisabled, generateDisabled: Boolean(reason), reason };
}
