import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "../generated/prisma/client.js";
import { env, isDev } from "../config/env.js";

// Runtime uses the POOLED connection string.
const adapter = new PrismaNeon({ connectionString: env.DATABASE_URL });

export const prisma = new PrismaClient({
  adapter,
  log: isDev ? ["warn", "error"] : ["error"],
});

/**
 * The read-only connection for dashboards and reports (DEC-210). Same as `prisma` until
 * REPORTS_DATABASE_URL is set (e.g. to a Neon read-only copy). Use it for READS only:
 * writes (e.g. the audit row for a download) go through `prisma`.
 */
export const reportsDb: PrismaClient = env.REPORTS_DATABASE_URL
  ? new PrismaClient({
      adapter: new PrismaNeon({ connectionString: env.REPORTS_DATABASE_URL }),
      log: isDev ? ["warn", "error"] : ["error"],
    })
  : prisma;
