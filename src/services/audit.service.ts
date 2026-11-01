import type { Prisma } from "../generated/prisma/client.js";
import { MASKED_FIELDS, SECRET_FIELDS } from "../config/sensitiveFields.js";
import { getRequestContext } from "../lib/requestContext.js";

const secretFields = new Set<string>(SECRET_FIELDS);
const maskedFields = new Set<string>(MASKED_FIELDS);

/**
 * A transaction client only. The root `prisma` client has `$connect` (a transaction
 * client doesn't), so passing it here does not compile: the audit row must be
 * written in the same transaction as the change it records (rule R4).
 */
type AuditTx = Prisma.TransactionClient & { $connect?: never };

export interface AuditEntry {
  /** The logged-in user. Null for system actions (seed, scheduled jobs). */
  actorId: string | null;
  /** `thing.verb`, e.g. "payout.approve", "partner.suspend", "setting.update". */
  action: `${string}.${string}`;
  entity: { type: string; id?: string };
  /** Only the fields that changed. Secrets are masked automatically. */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

/** "123456789012" → "XXXXXXXX9012". Values of 4 characters or fewer are hidden completely. */
function keepLastFour(value: unknown): string {
  const text = String(value);
  return text.length <= 4 ? "XXXX" : "X".repeat(text.length - 4) + text.slice(-4);
}

/** Copies the data, hiding secret fields at any depth and turning it into plain JSON. */
function sanitize(value: unknown, key?: string): Prisma.InputJsonValue | null {
  if (value === null || value === undefined) return null;
  if (key !== undefined && secretFields.has(key)) return "[REDACTED]";
  if (key !== undefined && maskedFields.has(key)) return keepLastFour(value);

  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (typeof value === "object") {
    // Prisma Decimal (rupees) and similar objects carry their own text form.
    if ("toJSON" in value && typeof value.toJSON === "function") {
      return sanitize(value.toJSON());
    }
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, sanitize(child, childKey)])
    );
  }
  if (typeof value === "bigint") return value.toString();
  return value as string | number | boolean;
}

/**
 * Writes one row to `audit_log`: who did what, to which record, before → after.
 * Call it inside the same `prisma.$transaction(async (tx) => …)` as the change,
 * so either both are saved or neither is. The request ID, IP and user agent
 * are filled in from the current request.
 */
export async function recordAudit(tx: AuditTx, entry: AuditEntry): Promise<void> {
  const context = getRequestContext();

  await tx.auditLog.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entity.type,
      entityId: entry.entity.id ?? null,
      ...(entry.before !== undefined && { before: sanitize(entry.before) ?? {} }),
      ...(entry.after !== undefined && { after: sanitize(entry.after) ?? {} }),
      ip: context?.ip ?? null,
      userAgent: context?.userAgent ?? null,
      requestId: context?.requestId ?? null,
    },
  });
}
