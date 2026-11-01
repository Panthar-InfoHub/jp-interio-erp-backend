import type { NextFunction, Request, RequestHandler, Response } from "express";

type AsyncRequestHandler<Req> = (req: Req, res: Response, next: NextFunction) => Promise<unknown>;

/**
 * Wraps an async route handler so a rejected promise reaches the error handler.
 *
 * Express 5 already forwards async errors on its own, so this is a safety net,
 * not a requirement. It keeps every handler consistent and makes the error
 * path explicit when someone reads the code.
 *
 * Pass `ValidatedRequest<typeof schemas>` as `Req` when `validate(schemas)` runs
 * before this handler, so `req.body` / `req.query` / `req.params` are typed.
 */
export const asyncHandler =
  <Req = Request>(fn: AsyncRequestHandler<Req>): RequestHandler =>
  (req, res, next) => {
    // Safe: the type only narrows what validate() already checked.
    fn(req as unknown as Req, res, next).catch(next);
  };
