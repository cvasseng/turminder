/** Errors that are the user's problem, not a bug: printed without a stack. */
export class UserFacingError extends Error {
  readonly code: string;
  readonly detail?: string;

  constructor(code: string, message: string, detail?: string) {
    super(message);
    this.name = 'UserFacingError';
    this.code = code;
    this.detail = detail;
  }
}

/** A config file (yaml/markdown) failed to load or validate. */
export class ConfigError extends UserFacingError {
  constructor(file: string, message: string, detail?: string) {
    super('config_invalid', `${file}: ${message}`, detail);
    this.name = 'ConfigError';
  }
}

export function isUserFacing(e: unknown): e is UserFacingError {
  return e instanceof UserFacingError;
}

export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
