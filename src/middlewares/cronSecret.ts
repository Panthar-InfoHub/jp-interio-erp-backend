import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { env } from "../config/env.js";
import { NotFoundError, UnauthorizedError } from "../utils/errors.js";

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * Lets only the hosting scheduler run the nightly jobs over HTTP (DEC-313).
 * - `CRON_SECRET` not set → the route doesn't exist (404).
 * - The request must send `Authorization: Bearer <CRON_SECRET>`; anything else → 401.
 * The header is already hidden in the logs (`req.headers.authorization` is redacted).
 * Both sides are hashed first so the comparison takes the same time whatever is sent.
 */
export const requireCronSecret: RequestHandler = (req, _res, next) => {
  const secret = env.CRON_SECRET;
  if (!secret) throw new NotFoundError(`Route ${req.method} ${req.originalUrl} not found`);

  const header = req.headers.authorization ?? "";
  const sent = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!sent || !timingSafeEqual(digest(sent), digest(secret))) {
    throw new UnauthorizedError("Not allowed.");
  }
  next();
};
