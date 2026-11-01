import type { Request, RequestHandler } from "express";
import type { z } from "zod";
import { ValidationError } from "../utils/errors.js";

/** Zod rules for each part of a request. Leave out the parts a route doesn't use. */
export interface RequestSchemas {
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
}

/**
 * The request type a controller sees after `validate(schemas)` has run:
 * params, query and body have the clean, parsed types from the schemas.
 */
export type ValidatedRequest<S extends RequestSchemas> = Request<
  S["params"] extends z.ZodType ? z.output<S["params"]> : Request["params"],
  unknown,
  S["body"] extends z.ZodType ? z.output<S["body"]> : unknown,
  S["query"] extends z.ZodType ? z.output<S["query"]> : Request["query"]
>;

const PARTS = ["params", "query", "body"] as const;

/**
 * Checks the request against Zod rules before the controller runs.
 * - Bad data: stops with 400 VALIDATION_ERROR and lists every problem
 *   (e.g. `body.points`, `query.page`), from all parts at once.
 * - Good data: replaces params / query / body with the clean values
 *   (unknown fields removed, "5" turned into 5 where the schema coerces).
 *
 * Usage:
 *   const schemas = { body: createPayoutBody } satisfies RequestSchemas;
 *   router.post("/", validate(schemas), asyncHandler<ValidatedRequest<typeof schemas>>(...));
 */
export function validate(schemas: RequestSchemas): RequestHandler {
  return async (req, _res, next) => {
    const problems: { path: string; message: string }[] = [];

    for (const part of PARTS) {
      const schema = schemas[part];
      if (!schema) continue;

      const result = await schema.safeParseAsync(req[part]);
      if (!result.success) {
        for (const issue of result.error.issues) {
          problems.push({
            path: [part, ...issue.path.map(String)].join("."),
            message: issue.message,
          });
        }
        continue;
      }

      if (part === "query") {
        // Express 5 makes req.query a read-only getter, so it is replaced this way.
        Object.defineProperty(req, "query", {
          value: result.data,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      } else if (part === "params") {
        req.params = result.data as Request["params"];
      } else {
        req.body = result.data;
      }
    }

    if (problems.length > 0) {
      throw new ValidationError("Invalid request data", problems);
    }
    next();
  };
}
