import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import { runWithRequestContext } from "../lib/requestContext.js";

// An ID sent by the app is reused only if it looks safe; otherwise we make a new one.
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/;

// Matches audit_log.user_agent (VarChar(500)).
const MAX_USER_AGENT_LENGTH = 500;

/**
 * Gives every request an ID, sends it back in `X-Request-Id`, and makes the
 * ID, IP and user agent available to all code that runs for this request.
 * Must be the FIRST middleware in app.ts.
 */
export const requestContext: RequestHandler = (req, res, next) => {
  const incomingId = req.get("x-request-id");
  const requestId =
    incomingId !== undefined && SAFE_REQUEST_ID.test(incomingId) ? incomingId : randomUUID();

  res.setHeader("X-Request-Id", requestId);

  runWithRequestContext(
    {
      requestId,
      ip: req.ip,
      userAgent: req.get("user-agent")?.slice(0, MAX_USER_AGENT_LENGTH),
    },
    next
  );
};
