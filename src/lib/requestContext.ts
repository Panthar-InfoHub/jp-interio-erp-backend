import { AsyncLocalStorage } from "node:async_hooks";

/** Info about the request being handled right now. */
export interface RequestContext {
  requestId: string;
  ip: string | undefined;
  userAgent: string | undefined;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with `context` available to everything it calls (sync or async). */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * The current request's info, readable from any service, the audit helper or the logger.
 * Undefined outside a request (seed script, scheduled jobs).
 */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
