export function errorMessage(error, fallback = 'Audio download could not be prepared.') {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : error?.message;
  const normalized = typeof message === 'string' ? message.trim() : '';
  return normalized || fallback;
}

export function asError(error, fallback) {
  if (error instanceof Error && error.message) return error;
  return new Error(errorMessage(error, fallback));
}
