import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { logger } from "../lib/logger.js";
import { getRequestContext } from "../lib/requestContext.js";
import { isProd } from "../config/env.js";
import {
  AppError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "../utils/errors.js";
import type { ApiErrorResponse } from "../utils/apiResponse.js";

// Prisma codes for "can't reach / lost the database".
const DB_UNREACHABLE_PRISMA_CODES = new Set(["P1001", "P1002", "P1017"]);
const DB_UNREACHABLE_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);

/**
 * The Neon driver reports a failed connection as a WebSocket ErrorEvent: not an
 * Error, with an empty message. Its `target.url` is the database host (no password).
 */
function asWebSocketErrorEvent(err: unknown): { url: string | undefined } | undefined {
  if (err instanceof Error || typeof err !== "object" || err === null) return undefined;
  const event = err as { type?: unknown; target?: { url?: unknown } };
  if (event.type !== "error" || typeof event.target !== "object") return undefined;
  return { url: typeof event.target.url === "string" ? event.target.url : undefined };
}

function isDatabaseUnreachable(err: unknown): boolean {
  if (asWebSocketErrorEvent(err)) return true;
  if (err instanceof Prisma.PrismaClientInitializationError) return true;
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return DB_UNREACHABLE_PRISMA_CODES.has(err.code);
  }
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && DB_UNREACHABLE_NETWORK_CODES.has(code);
}

/** A readable reason for the log, even when the thrown value isn't a normal Error. */
function describeError(err: unknown): string {
  const event = asWebSocketErrorEvent(err);
  if (event) return `Database connection failed (WebSocket error, ${event.url ?? "unknown host"})`;
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/** Turns any thrown value into an AppError with the right status code. */
function normalizeError(err: unknown): AppError {
  // 1. Errors we threw on purpose.
  if (err instanceof AppError) return err;

  // 2. Zod validation failures (from schema.parse in a controller).
  if (err instanceof ZodError) {
    return new ValidationError(
      "Invalid request data",
      err.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }))
    );
  }

  // 3. Known Prisma errors that map cleanly onto HTTP statuses.
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case "P2002": // unique constraint violation
        return new ConflictError("A record with this value already exists");
      case "P2025": // record to update/delete not found
        return new NotFoundError("Record not found");
    }
  }

  // 4. express.json() errors: malformed JSON or an oversized body.
  if (typeof err === "object" && err !== null && "type" in err) {
    const type = (err as { type?: unknown }).type;
    if (type === "entity.parse.failed") {
      return new ValidationError("Malformed JSON in request body");
    }
    if (type === "entity.too.large") {
      return new AppError("Request body too large", 413, "PAYLOAD_TOO_LARGE");
    }
  }

  // 5. The database can't be reached: temporary, the client may retry (DEC-030).
  if (isDatabaseUnreachable(err)) return new ServiceUnavailableError();

  // 6. Anything else is a bug.
  return new AppError(describeError(err), 500, "INTERNAL_SERVER_ERROR");
}

/**
 * The single place that turns errors into HTTP responses.
 * Must be registered LAST in app.ts, and must keep all four parameters:
 * that is how Express recognises it as an error handler.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // If the response has already started streaming, Express must close it.
  if (res.headersSent) {
    next(err);
    return;
  }

  const appError = normalizeError(err);
  const isServerError = appError.statusCode >= 500;

  // Non-Error values (like the database's ErrorEvent) print as noise, so log their reason instead.
  const logContext = {
    ...(err instanceof Error ? { err } : { reason: describeError(err) }),
    method: req.method,
    url: req.originalUrl,
  };
  if (isServerError) {
    logger.error(logContext, appError.message);
  } else {
    logger.warn(logContext, appError.message);
  }

  // Never leak internal error messages (500) to clients in production.
  // A 503 message is safe and tells the client to retry.
  const message =
    appError.statusCode === 500 && isProd
      ? "Something went wrong. Please try again later."
      : appError.message;

  const requestId = getRequestContext()?.requestId;

  const body: ApiErrorResponse = {
    success: false,
    error: {
      code: appError.code,
      message,
      ...(appError.details !== undefined && { details: appError.details }),
      ...(requestId !== undefined && { requestId }),
    },
  };

  res.status(appError.statusCode).json(body);
};
