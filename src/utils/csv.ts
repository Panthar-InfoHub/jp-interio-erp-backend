import { once } from "node:events";
import type { Writable } from "node:stream";

/**
 * CSV files for Excel (QR export, Module 16 reports; DEC-224).
 * - UTF-8 with a BOM, so Excel shows ₹ and Indian-language names correctly.
 * - Text starting with = + - @ (or a tab / line break) gets a ' in front, so a typed name can
 *   never run as an Excel formula ("CSV injection"). Numbers are left alone.
 * - Dates and times in India time.
 */

/** Makes Excel open the file as UTF-8. */
export const CSV_BOM = "﻿";

const IST_DATE_TIME = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** A moment as India sees it, e.g. "2026-11-21 14:05:09". */
export function istDateTime(value: Date): string {
  const parts = Object.fromEntries(
    IST_DATE_TIME.formatToParts(value).map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** One cell: empty for null, India time for dates, formula-safe and quoted when needed. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return istDateTime(value);
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  const text = String(value);
  const safe = /^[=+\-@\t\r\n]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** One line, ending in CRLF (what Excel expects). */
export function csvLine(cells: readonly unknown[]): string {
  return `${cells.map(csvCell).join(",")}\r\n`;
}

/**
 * Sends a CSV piece by piece: BOM + header, then each batch of rows, waiting whenever the
 * connection is full so memory stays small for any size (DEC-208). Stops quietly if the
 * person cancels the download.
 */
export async function writeCsv(
  out: Writable,
  header: readonly string[],
  batches: AsyncIterable<readonly (readonly unknown[])[]>
): Promise<void> {
  let closed = false;
  out.once("close", () => {
    closed = true;
  });
  const send = async (chunk: string) => {
    if (!out.write(chunk)) await once(out, "drain");
  };

  await send(CSV_BOM + csvLine(header));
  for await (const rows of batches) {
    if (closed) return;
    if (rows.length > 0) await send(rows.map(csvLine).join(""));
  }
  if (!closed) out.end();
}
