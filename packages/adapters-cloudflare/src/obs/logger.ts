import { redact } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Fields every log line carries when known. */
export interface LogContext {
  requestId?: string;
  principalId?: string;
  principalType?: string;
  /** Delegation chain, outermost actor first (RFC 8693 `act`). */
  act?: string[];
  route?: string;
  repoId?: string;
  [key: string]: unknown;
}

export interface Logger {
  readonly context: Readonly<LogContext>;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(context: LogContext): Logger;
}

export type LogSink = (level: LogLevel, line: string) => void;

// Workers Logs parses a JSON object written with console.* into fields.
const consoleSink: LogSink = (level, line) => {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

/** One JSON object per line, redacted (tokens, credentials, secret fields). */
export function createLogger(context: LogContext = {}, sink: LogSink = consoleSink): Logger {
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    sink(level, JSON.stringify(redact({ level, msg, ...context, ...fields })));
  };
  return {
    context,
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (more) => createLogger({ ...context, ...more }, sink),
  };
}

/**
 * Request metadata passed explicitly across Durable Object RPC hops, so a log
 * line written inside a DO carries the same request id and principal.
 */
export type RequestMeta = Pick<LogContext, "requestId" | "principalId" | "principalType" | "act">;

export function requestMeta(logger: Logger): RequestMeta {
  const { requestId, principalId, principalType, act } = logger.context;
  return {
    ...(requestId !== undefined && { requestId }),
    ...(principalId !== undefined && { principalId }),
    ...(principalType !== undefined && { principalType }),
    ...(act !== undefined && { act }),
  };
}
