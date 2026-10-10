/** The message of any thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Replace the message but keep the error class, so the server can attach recovery guidance. */
export function errorWithContext(error: unknown, message: string): Error {
  if (error instanceof Error) {
    error.message = message;
    return error;
  }
  return new Error(message);
}

/** A failed cleanup step replaces the result; an earlier operation failure stays in its message. */
export function withCleanupFailure(cleanup: unknown, operation: unknown, step: string): unknown {
  return operation === undefined
    ? cleanup
    : errorWithContext(cleanup, `${errorMessage(operation)}. ${step} also failed: ${errorMessage(cleanup)}`);
}
