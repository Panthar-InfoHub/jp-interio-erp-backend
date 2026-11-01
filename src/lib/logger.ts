import { pino } from "pino";
import { env, isDev } from "../config/env.js";
import { MASKED_FIELDS, SECRET_FIELDS } from "../config/sensitiveFields.js";
import { getRequestContext } from "./requestContext.js";

export const logger = pino({
  level: env.LOG_LEVEL ?? (isDev ? "debug" : "info"),

  // Stamp the current request ID on every log line, including lines from services.
  mixin() {
    const context = getRequestContext();
    return context ? { requestId: context.requestId } : {};
  },

  // Never write secrets to logs.
  // Each "*" matches exactly one level, so list every depth we care about.
  // The field names live in config/sensitiveFields.ts, shared with the audit helper.
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      // The raw body of a request whose JSON could not be parsed (may hold an OTP).
      "err.body",
      ...[...SECRET_FIELDS, ...MASKED_FIELDS].flatMap((field) => [
        field,
        `*.${field}`,
        `*.*.${field}`,
      ]),
    ],
    censor: "[REDACTED]",
  },

  // Human-readable output in development; raw JSON in production
  // (log platforms parse the JSON).
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss",
            ignore: "pid,hostname",
          },
        },
      }
    : {}),
});
