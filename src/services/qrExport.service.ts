import { once } from "node:events";
import type { Writable } from "node:stream";
import { ZipArchive } from "archiver";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import type { AuthUser } from "../middlewares/auth.js";
import { csvCell } from "../utils/csv.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";
import { qrLink } from "../utils/qrCode.js";
import { qrPng, qrSvg } from "../utils/qrImage.js";
import { recordAudit } from "./audit.service.js";
import { lockBatch } from "./qrBatch.service.js";

/**
 * Download a QR batch for printing (Module 7 T4, DEC-118, DEC-123).
 * - One ZIP: `codes.csv` + `images-png/<CODE>.png` (1000 × 1000) + `images-svg/<CODE>.svg`.
 * - Any number of downloads, always the same codes; no extra approval (DEC-118).
 * - Logged when the download starts (download log + audit). The first download moves the
 *   batch from `generated` to `exported`.
 * - A voided batch can't be downloaded (DEC-123).
 */

export interface ExportInfo {
  batchId: string;
  batchNo: string;
  productSku: string;
  productName: string;
}

/**
 * Step 1: checks and logs the download, before any file is sent.
 * The batch row is locked so a void (T5) and a download can't cross each other.
 */
export async function startExport(actor: AuthUser, batchId: string): Promise<ExportInfo> {
  return prisma.$transaction(async (tx) => {
    await lockBatch(tx, batchId);
    const batch = await tx.qrBatch.findUnique({
      where: { id: batchId },
      select: {
        id: true,
        batchNo: true,
        status: true,
        product: { select: { sku: true, name: true } },
        _count: { select: { exports: true } },
      },
    });
    if (!batch) throw new NotFoundError("QR batch not found");
    if (batch.status === "voided") {
      throw new ConflictError(`Batch ${batch.batchNo} is voided and can't be downloaded`);
    }

    await tx.qrBatchExport.create({ data: { batchId: batch.id, exportedById: actor.id } });
    const firstDownload = batch.status === "generated";
    if (firstDownload) {
      await tx.qrBatch.update({
        where: { id: batch.id },
        data: { status: "exported", firstExportedAt: new Date() },
      });
    }

    await recordAudit(tx, {
      actorId: actor.id,
      action: "qr_batch.export",
      entity: { type: "qr_batch", id: batch.id },
      ...(firstDownload && { before: { status: "generated" } }),
      after: {
        batchNo: batch.batchNo,
        downloadNumber: batch._count.exports + 1,
        ...(firstDownload && { status: "exported" }),
      },
    });

    return {
      batchId: batch.id,
      batchNo: batch.batchNo,
      productSku: batch.product.sku,
      productName: batch.product.name,
    };
  });
}

/**
 * One CSV cell. Quoted when needed; a value starting with = + - @ gets a leading ' so
 * Excel never runs it as a formula.
 */
function buildCsv(info: ExportInfo, codes: string[]): string {
  const header = ["batch_no", "code", "link", "product_sku", "product_name"];
  const lines = [header.join(",")];
  for (const code of codes) {
    lines.push(
      [info.batchNo, code, qrLink(code), info.productSku, info.productName].map(csvCell).join(",")
    );
  }
  // The BOM makes Excel open the file as UTF-8 (product names may have non-English letters).
  return `﻿${lines.join("\r\n")}\r\n`;
}

/**
 * Step 2: builds the ZIP and sends it piece by piece to `out` (the HTTP response).
 * Each picture is made only when the ZIP is ready for it, so memory stays small even for
 * 10,000 codes. Stops quietly if the person cancels the download.
 */
export async function streamExportZip(info: ExportInfo, out: Writable): Promise<void> {
  const rows = await prisma.qrCode.findMany({
    where: { batchId: info.batchId },
    select: { code: true },
    orderBy: { id: "asc" },
  });
  await writeExportZip(
    info,
    rows.map((row) => row.code),
    out
  );
}

/** Builds the ZIP for these codes into `out`. Separate so it can be tried without a database. */
export async function writeExportZip(
  info: ExportInfo,
  codes: string[],
  out: Writable
): Promise<void> {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const cancelled = new AbortController();
  out.on("close", () => {
    if (!out.writableFinished) {
      cancelled.abort();
      archive.abort();
    }
  });
  archive.on("warning", (err) => logger.warn({ err, batchNo: info.batchNo }, "QR export warning"));
  // Always listening: an 'error' with no listener would crash the whole server. The error
  // itself still reaches the code below through `once(...)`, or is expected after a cancel.
  archive.on("error", (err) => {
    if (!cancelled.signal.aborted) logger.error({ err, batchNo: info.batchNo }, "QR export failed");
  });
  archive.pipe(out);

  /** Adds one file and waits until the ZIP has taken it in (keeps memory small). */
  const add = async (content: Buffer | string, name: string, store = false) => {
    // Cancelled while the picture was being made: don't touch the closed ZIP.
    cancelled.signal.throwIfAborted();
    const added = once(archive, "entry", { signal: cancelled.signal });
    archive.append(content, { name, store });
    await added;
  };

  try {
    await add(buildCsv(info, codes), "codes.csv");
    for (const code of codes) {
      const link = qrLink(code);
      // PNGs are already compressed; storing them as-is is faster and no bigger.
      await add(qrPng(link), `images-png/${code}.png`, true);
      await add(await qrSvg(link), `images-svg/${code}.svg`);
    }
    await archive.finalize();
  } catch (err) {
    if (cancelled.signal.aborted) {
      logger.info({ batchNo: info.batchNo }, "QR export cancelled by the client");
      return;
    }
    throw err;
  }
}
