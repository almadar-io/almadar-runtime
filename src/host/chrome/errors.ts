export type ChromePortErrorCode = 'CANCELLED' | 'TIMEOUT_ERROR' | 'MODEL_UNAVAILABLE' | 'AUTH_ERROR';

/** A raw Chrome port that could not answer; `code` says why, `details` carries the numbers a message names. */
export class ChromePortError extends Error {
  readonly code: ChromePortErrorCode;
  readonly details: Record<string, number>;

  constructor(message: string, code: ChromePortErrorCode, details: Record<string, number> = {}) {
    super(message);
    this.name = 'ChromePortError';
    this.code = code;
    this.details = details;
  }
}

export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

export function cancelled(): ChromePortError {
  return new ChromePortError('The call was cancelled', 'CANCELLED');
}
