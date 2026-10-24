const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const positiveLimit = (value) => Number.isSafeInteger(value) && value > 0;

export function validateConfig(data) {
  if (!data || typeof data.configured !== 'boolean' || data.streaming !== true || !positiveLimit(data.guestWordLimit) ||
      !data.auth || typeof data.auth.enabled !== 'boolean' || typeof data.auth.signedIn !== 'boolean' ||
      typeof data.auth.admin !== 'boolean' ||
      (data.auth.signedIn && !data.auth.enabled) || (data.auth.admin && !data.auth.signedIn) ||
      !Array.isArray(data.voices) || !data.voices.every(nonempty) || new Set(data.voices).size !== data.voices.length ||
      !Array.isArray(data.models) || !data.models.length || !data.models.every((model) => model &&
        nonempty(model.id) && model.id.length <= 200 && !/\s/.test(model.id) &&
        positiveLimit(model.characterLimit) && positiveLimit(model.wordLimit) &&
        typeof model.requiresLogin === 'boolean') ||
      new Set(data.models.map((model) => model.id)).size !== data.models.length) {
    throw new Error('The server returned an invalid streaming model catalog.');
  }
  for (const key of ['defaultModelId', 'modelId']) {
    if (data[key] != null && (!nonempty(data[key]) || !data.models.some((model) => model.id === data[key]))) {
      throw new Error('The server returned an invalid default model.');
    }
  }
  if (data.configured && (!data.voices.length || !(data.defaultModelId || data.modelId))) {
    throw new Error('The server returned an incomplete streaming configuration.');
  }
  return data;
}

export function countRequestWords(requestText) {
  return requestText.match(/\S+/gu)?.length ?? 0;
}

// A selected model has no word cap only for a signed-in admin from server config.
// null also preserves the existing no-model state.
export function getRequestWordLimit(model, auth, guestWordLimit) {
  if (!model) return null;
  if (auth?.signedIn === true && auth?.admin === true) return null;
  return auth?.signedIn === true ? model.wordLimit : Math.min(model.wordLimit, guestWordLimit);
}
