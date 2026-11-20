import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import type { AuthUser } from "../middlewares/auth.js";
import { formatBatchNo, newQrCode, parseQrInput, qrLink } from "../utils/qrCode.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import { pageMeta, toPrismaOrderBy, toPrismaPaging } from "../utils/pagination.js";
import type {
  CreateQrBatchInput,
  ListBatchCodesQuery,
  ListQrBatchesQuery,
  VoidQrBatchInput,
} from "../validators/qrBatch.schema.js";
import { recordAudit } from "./audit.service.js";
import { assertProductUsable } from "./product.service.js";
import { getSetting } from "./settings.service.js";

/**
 * QR batches (Module 7).
 * - Managed by the Admin and the QR Batches Sub-Admin (`qr.*` permissions, DEC-018, DEC-019).
 * - A batch is made straight away in one request (batches are small, DEC-118).
 * - Every code in a batch carries the same points. Making a batch creates money the
 *   company may owe, so it is always audited.
 * - Nothing is ever deleted; a batch can only be voided, and that is permanent (DEC-124).
 */

/**
 * Locks one batch row until the transaction ends. Used by download (T4), void (T5) and,
 * later, scanning (Module 9), so none of them can cross another on the same batch.
 */
export async function lockBatch(tx: Prisma.TransactionClient, batchId: string) {
  await tx.$queryRaw`SELECT 1 FROM qr_batches WHERE id = ${batchId}::uuid FOR UPDATE`;
}

/** Codes are saved this many at a time. */
const INSERT_CHUNK = 1_000;

/** Making 10,000 codes takes a few seconds on Neon; the default 5 s is too short. */
const CREATE_TX_OPTIONS = { maxWait: 10_000, timeout: 60_000 } as const;

const BATCH_FIELDS = {
  id: true,
  batchNo: true,
  quantity: true,
  pointsPerCode: true,
  status: true,
  notes: true,
  firstExportedAt: true,
  voidedAt: true,
  voidReason: true,
  createdAt: true,
  updatedAt: true,
  product: { select: { id: true, sku: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  voidedBy: { select: { id: true, name: true } },
  _count: { select: { exports: true } },
} satisfies Prisma.QrBatchSelect;

type BatchRow = Prisma.QrBatchGetPayload<{ select: typeof BATCH_FIELDS }>;

/** Adds the total points value (quantity × points per code) and the download count. */
function toBatchSummary(batch: BatchRow) {
  const { _count, ...rest } = batch;
  return {
    ...rest,
    totalPoints: batch.quantity * batch.pointsPerCode,
    downloadCount: _count.exports,
  };
}

type CodeCounts = { active: number; scanned: number; void: number };

/** Unused / scanned / voided counts for each batch, with one query in total. */
async function codeCountsFor(batchIds: string[]): Promise<Map<string, CodeCounts>> {
  const counts = new Map<string, CodeCounts>(
    batchIds.map((id) => [id, { active: 0, scanned: 0, void: 0 }])
  );
  if (batchIds.length === 0) return counts;
  const rows = await prisma.qrCode.groupBy({
    by: ["batchId", "status"],
    where: { batchId: { in: batchIds } },
    _count: { _all: true },
  });
  for (const row of rows) counts.get(row.batchId)![row.status] = row._count._all;
  return counts;
}

/** One lock for batch numbers, so two batches made at the same moment never share one. */
async function lockBatchNumbers(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"qr:batch_no"}::text, 0))`;
}

/** The next number in this UTC year: 1 for the first batch of the year (DEC-120). */
async function nextBatchNumber(tx: Prisma.TransactionClient) {
  await lockBatchNumbers(tx);
  const year = new Date().getUTCFullYear();
  const last = await tx.qrBatch.aggregate({ where: { year }, _max: { seq: true } });
  const seq = (last._max.seq ?? 0) + 1;
  return { year, seq, batchNo: formatBatchNo(year, seq) };
}

/**
 * Saves `quantity` new codes for the batch, `INSERT_CHUNK` at a time.
 * A code that already exists (practically never: 60 random bits) is skipped by the
 * database's unique rule, and a new one is made in its place until the count is right.
 */
async function insertCodes(
  tx: Prisma.TransactionClient,
  batchId: string,
  productId: string,
  quantity: number
) {
  let remaining = quantity;
  while (remaining > 0) {
    const size = Math.min(remaining, INSERT_CHUNK);
    const codes = new Set<string>();
    while (codes.size < size) codes.add(newQrCode());

    const { count } = await tx.qrCode.createMany({
      data: [...codes].map((code) => ({ code, batchId, productId })),
      skipDuplicates: true,
    });
    remaining -= count;
  }
}

/** The batch with this id, or 404. */
async function findBatch(id: string, db: Prisma.TransactionClient = prisma): Promise<BatchRow> {
  const batch = await db.qrBatch.findUnique({ where: { id }, select: BATCH_FIELDS });
  if (!batch) throw new NotFoundError("QR batch not found");
  return batch;
}

/** POST /qr/batches — makes the batch and all its codes in one transaction. */
export async function createBatch(actor: AuthUser, input: CreateQrBatchInput) {
  const [maxBatchSize, maxPointsPerCode] = await Promise.all([
    getSetting("qr.max_batch_size"),
    getSetting("qr.max_points_per_code"),
  ]);
  const problems: { path: string; message: string }[] = [];
  if (input.quantity > maxBatchSize) {
    problems.push({
      path: "body.quantity",
      message: `Quantity can be at most ${maxBatchSize.toLocaleString("en-IN")} codes per batch`,
    });
  }
  if (input.pointsPerCode > maxPointsPerCode) {
    problems.push({
      path: "body.pointsPerCode",
      message: `Points per code can be at most ${maxPointsPerCode.toLocaleString("en-IN")}`,
    });
  }
  if (problems.length > 0) throw new ValidationError("Invalid request data", problems);

  const batch = await prisma.$transaction(async (tx) => {
    // Share lock on the product row: a SKU change waits for this batch (or this batch
    // waits for it), so the SKU lock can never be slipped past (DEC-122).
    await tx.$queryRaw`SELECT 1 FROM products WHERE id = ${input.productId}::uuid FOR SHARE`;
    // Only the product itself must be on; its brand / category may be off (DEC-110).
    const product = await assertProductUsable(input.productId, "qr_batch", tx);
    const { year, seq, batchNo } = await nextBatchNumber(tx);

    const created = await tx.qrBatch.create({
      data: {
        batchNo,
        year,
        seq,
        productId: product.id,
        quantity: input.quantity,
        pointsPerCode: input.pointsPerCode,
        notes: input.notes ?? null,
        createdById: actor.id,
      },
      select: { id: true },
    });

    await insertCodes(tx, created.id, product.id, input.quantity);

    await recordAudit(tx, {
      actorId: actor.id,
      action: "qr_batch.create",
      entity: { type: "qr_batch", id: created.id },
      after: {
        batchNo,
        productId: product.id,
        productSku: product.sku,
        quantity: input.quantity,
        pointsPerCode: input.pointsPerCode,
        totalPoints: input.quantity * input.pointsPerCode,
        notes: input.notes ?? null,
      },
    });

    return findBatch(created.id, tx);
  }, CREATE_TX_OPTIONS);

  return toBatchSummary(batch);
}

// ---------------------------------------------------------------------------
// Lists and lookup (T6, DEC-125). Read-only; `qr.view`.
// ---------------------------------------------------------------------------

/** GET /qr/batches — newest first by default, with code counts per batch. */
export async function listBatches(query: ListQrBatchesQuery) {
  const where: Prisma.QrBatchWhereInput = {
    ...(query.status && { status: query.status }),
    ...(query.productId && { productId: query.productId }),
    ...((query.createdFrom || query.createdTo) && {
      createdAt: {
        ...(query.createdFrom && { gte: query.createdFrom }),
        ...(query.createdTo && { lte: query.createdTo }),
      },
    }),
    ...(query.search && { batchNo: { contains: query.search, mode: "insensitive" } }),
  };

  const [batches, total] = await Promise.all([
    prisma.qrBatch.findMany({
      where,
      select: BATCH_FIELDS,
      orderBy: toPrismaOrderBy(query.sort),
      ...toPrismaPaging(query.page, query.limit),
    }),
    prisma.qrBatch.count({ where }),
  ]);

  const counts = await codeCountsFor(batches.map((batch) => batch.id));
  return {
    items: batches.map((batch) => ({
      ...toBatchSummary(batch),
      codeCounts: counts.get(batch.id)!,
    })),
    meta: pageMeta(query.page, query.limit, total),
  };
}

/** GET /qr/batches/:id — summary, counts, notes, every download, void details. */
export async function getBatch(id: string) {
  const batch = await findBatch(id);
  const [counts, downloads] = await Promise.all([
    codeCountsFor([id]),
    prisma.qrBatchExport.findMany({
      where: { batchId: id },
      select: { id: true, createdAt: true, exportedBy: { select: { id: true, name: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
  ]);
  return { ...toBatchSummary(batch), codeCounts: counts.get(id)!, downloads };
}

/** Who scanned a code: the partner's name, phone and type (DEC-125). */
const SCANNED_BY_FIELDS = {
  id: true,
  name: true,
  phone: true,
  partnerProfile: { select: { partnerType: true } },
} satisfies Prisma.UserSelect;

type ScannedByRow = Prisma.UserGetPayload<{ select: typeof SCANNED_BY_FIELDS }>;

function presentScannedBy(user: ScannedByRow | null) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    partnerType: user.partnerProfile?.partnerType ?? null,
  };
}

/** GET /qr/batches/:id/codes — paged, same order as the download by default. */
export async function listBatchCodes(id: string, query: ListBatchCodesQuery) {
  await findBatch(id);
  const where: Prisma.QrCodeWhereInput = {
    batchId: id,
    ...(query.status && { status: query.status }),
    ...(query.search && { code: { contains: query.search } }),
  };

  const [codes, total] = await Promise.all([
    prisma.qrCode.findMany({
      where,
      select: {
        id: true,
        code: true,
        status: true,
        scannedAt: true,
        scannedBy: { select: SCANNED_BY_FIELDS },
      },
      orderBy: toPrismaOrderBy(query.sort),
      ...toPrismaPaging(query.page, query.limit),
    }),
    prisma.qrCode.count({ where }),
  ]);

  return {
    items: codes.map((code) => ({
      ...code,
      link: qrLink(code.code),
      scannedBy: presentScannedBy(code.scannedBy),
    })),
    meta: pageMeta(query.page, query.limit, total),
  };
}

/**
 * GET /qr/codes/:code — the full story of one code. Takes the plain code or the full
 * link (any case, spaces ignored). Unknown or malformed → 404.
 */
export async function lookupCode(input: string) {
  const code = parseQrInput(input);
  if (!code) throw new NotFoundError("QR code not found");

  const row = await prisma.qrCode.findUnique({
    where: { code },
    select: {
      id: true,
      code: true,
      status: true,
      scannedAt: true,
      createdAt: true,
      scannedBy: { select: SCANNED_BY_FIELDS },
      product: { select: { id: true, sku: true, name: true } },
      batch: {
        select: {
          id: true,
          batchNo: true,
          status: true,
          pointsPerCode: true,
          createdAt: true,
          voidedAt: true,
          voidReason: true,
        },
      },
    },
  });
  if (!row) throw new NotFoundError("QR code not found");

  return { ...row, link: qrLink(row.code), scannedBy: presentScannedBy(row.scannedBy) };
}

/**
 * POST /qr/batches/:id/void — permanent (DEC-117, DEC-124).
 * Unused codes become `void`; scanned codes and their points are not touched.
 * A batch with every code scanned can still be voided (0 codes change).
 * Voiding an already voided batch changes nothing.
 */
export async function voidBatch(actor: AuthUser, id: string, input: VoidQrBatchInput) {
  return prisma.$transaction(async (tx) => {
    await lockBatch(tx, id);
    const batch = await findBatch(id, tx);
    if (batch.status === "voided") {
      return { batch: toBatchSummary(batch), changed: false, codesVoided: 0, alreadyScanned: 0 };
    }

    const alreadyScanned = await tx.qrCode.count({ where: { batchId: id, status: "scanned" } });
    const { count: codesVoided } = await tx.qrCode.updateMany({
      where: { batchId: id, status: "active" },
      data: { status: "void" },
    });
    await tx.qrBatch.update({
      where: { id },
      data: {
        status: "voided",
        voidedAt: new Date(),
        voidedById: actor.id,
        voidReason: input.reason,
      },
    });

    await recordAudit(tx, {
      actorId: actor.id,
      action: "qr_batch.void",
      entity: { type: "qr_batch", id },
      before: { status: batch.status },
      after: {
        status: "voided",
        batchNo: batch.batchNo,
        reason: input.reason,
        codesVoided,
        alreadyScanned,
        pointsCancelled: codesVoided * batch.pointsPerCode,
      },
    });

    return {
      batch: toBatchSummary(await findBatch(id, tx)),
      changed: true,
      codesVoided,
      alreadyScanned,
    };
  });
}
