export class AppError extends Error {
  constructor(
    message: string,
    public code: string,
    public httpStatus: number = 400
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class SetupError extends AppError {
  constructor(message: string) {
    super(message, "missing_api_key", 428);
    this.name = "SetupError";
  }
}

/** Thrown by workers when their job was cancelled; callers unwind, not fail. */
export class JobCancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "JobCancelledError";
  }
}

export class ElevenLabsError extends AppError {
  constructor(
    message: string,
    code: string,
    httpStatus: number,
    public retryable: boolean
  ) {
    super(message, code, httpStatus);
    this.name = "ElevenLabsError";
  }
}

export function errorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    return Response.json(
      { error: err.message, code: err.code },
      { status: err.httpStatus }
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(err);
  return Response.json({ error: message, code: "internal" }, { status: 500 });
}

export function requireEnv(name: "ANTHROPIC_API_KEY" | "ELEVENLABS_API_KEY"): string {
  const value = process.env[name];
  if (!value) {
    throw new SetupError(
      `${name} is not set. Add it to .env.local and restart the dev server.`
    );
  }
  return value;
}
