import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env.js";
import {
  ALLOWED_CONTENT_TYPES,
  type AllowedContentType,
  UPLOAD_LINK_SECONDS,
  UPLOAD_PURPOSES,
  type UploadPurpose,
  sizeLabel,
  uploadRule,
} from "../config/uploads.js";
import { R2_BUCKET, r2 } from "../lib/storage/r2Client.js";
import { logger } from "../lib/logger.js";
import type { AuthUser } from "../middlewares/auth.js";
import { ForbiddenError, ValidationError } from "../utils/errors.js";
import { getPermissionScope } from "./permission.service.js";

/**
 * File storage on Cloudflare R2 (Module 5 T3, DEC-084 – DEC-086).
 *
 * 1. The app asks for an upload link (`createUploadLink`).
 * 2. The app uploads the file straight to R2 with an HTTP PUT; it never passes through us.
 * 3. When the app saves the record (e.g. a KYC document) with the file URL, the service
 *    calls `verifyUploadedFile` before saving: the file must exist, be ours, and match.
 *
 * File names: {STORAGE_PREFIX}/{purpose folder}/{uploader id}/{random}.{ext}
 * No name, phone or document number ever appears in a file name.
 */

export interface UploadLink {
  /** PUT the file bytes to this link, with the headers below, within `expiresAt`. */
  uploadUrl: string;
  method: "PUT";
  headers: { "Content-Type": AllowedContentType };
  /** The file's public URL once uploaded. Send this back when saving the record. */
  fileUrl: string;
  expiresAt: string;
}

export interface VerifiedFile {
  fileUrl: string;
  contentType: AllowedContentType;
  sizeBytes: number;
}

function folderFor(purpose: UploadPurpose, uploaderId: string): string {
  return `${env.STORAGE_PREFIX}/${UPLOAD_PURPOSES[purpose].folder}/${uploaderId}/`;
}

function publicUrlFor(key: string): string {
  return `${env.R2_PUBLIC_BASE_URL}/${key}`;
}

/** The file name inside the bucket for one of our public URLs, or null if it isn't ours. */
export function keyFromUrl(fileUrl: string): string | null {
  const base = `${env.R2_PUBLIC_BASE_URL}/`;
  if (!fileUrl.startsWith(base)) return null;
  const key = fileUrl.slice(base.length);
  return /^[a-z0-9-]+\/[a-z0-9-]+\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.[a-z]+$/.test(key) ? key : null;
}

/** Step 1: a 5-minute signed link to upload one file straight to R2. */
export async function createUploadLink(
  actor: AuthUser,
  input: { purpose: UploadPurpose; contentType: AllowedContentType; sizeBytes: number }
): Promise<UploadLink> {
  const rule = uploadRule(input.purpose);
  const allowed =
    (rule.roles as readonly number[]).includes(actor.roleId) &&
    (!rule.capability || (await getPermissionScope(actor, rule.capability)) !== null);
  if (!allowed) throw new ForbiddenError("You cannot upload files for this.");
  // The validator already checks these; repeated here so the service is safe on its own.
  if (!rule.contentTypes.includes(input.contentType)) {
    throw new ValidationError(`The file must be ${rule.typesLabel}.`);
  }
  if (input.sizeBytes > rule.maxBytes) {
    throw new ValidationError(`The file must be ${sizeLabel(rule.maxBytes)} or smaller.`);
  }

  const extension = ALLOWED_CONTENT_TYPES[input.contentType];
  const key = `${folderFor(input.purpose, actor.id)}${randomUUID()}.${extension}`;

  // Type and size are part of the signature: R2 refuses an upload that doesn't match.
  const uploadUrl = await getSignedUrl(
    r2,
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      ContentType: input.contentType,
      ContentLength: input.sizeBytes,
    }),
    { expiresIn: UPLOAD_LINK_SECONDS, signableHeaders: new Set(["content-type", "content-length"]) }
  );

  return {
    uploadUrl,
    method: "PUT",
    headers: { "Content-Type": input.contentType },
    fileUrl: publicUrlFor(key),
    expiresAt: new Date(Date.now() + UPLOAD_LINK_SECONDS * 1000).toISOString(),
  };
}

// ---- Checking the real file content (the first bytes), not just its name ----

function startsWith(bytes: Buffer, signature: number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);

function contentMatches(type: AllowedContentType, bytes: Buffer): boolean {
  switch (type) {
    case "application/pdf":
      return startsWith(bytes, ascii("%PDF-"));
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/webp":
      return startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8);
    case "image/heic":
    case "image/heif":
      return (
        startsWith(bytes, ascii("ftyp"), 4) &&
        HEIF_BRANDS.has(bytes.subarray(8, 12).toString("latin1"))
      );
  }
}

function isNotFound(error: unknown): boolean {
  const meta = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return meta?.httpStatusCode === 404 || (error as Error).name === "NotFound";
}

/** Removes a file. Never throws: a file left behind is harmless, a failed save is not. */
export async function deleteFile(fileUrl: string): Promise<void> {
  const key = keyFromUrl(fileUrl);
  if (!key) return;
  try {
    await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  } catch (error) {
    logger.warn({ err: error, key }, "Could not delete file from R2");
  }
}

/**
 * Step 3: checks an uploaded file before a record points to it.
 * - The URL must be one of ours, in this purpose's folder, uploaded by this user
 *   (so nobody can attach someone else's file or a random link).
 * - The file must exist, and fit this purpose's types and size limit (KYC: PDF or image,
 *   10 MB; product image: JPG / PNG / WebP, 5 MB — config/uploads.ts).
 * - Its first bytes must match its type (a renamed .exe is refused and deleted).
 */
export async function verifyUploadedFile(
  actor: AuthUser,
  purpose: UploadPurpose,
  fileUrl: string,
  label = "file"
): Promise<VerifiedFile> {
  const key = keyFromUrl(fileUrl);
  if (!key || !key.startsWith(folderFor(purpose, actor.id))) {
    throw new ValidationError(`The ${label} link is not valid. Please upload the file again.`);
  }

  let head;
  try {
    head = await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  } catch (error) {
    if (isNotFound(error)) {
      throw new ValidationError(`The ${label} was not uploaded. Please upload it again.`);
    }
    throw error;
  }

  const rule = uploadRule(purpose);
  const contentType = head.ContentType as AllowedContentType | undefined;
  const sizeBytes = head.ContentLength ?? 0;
  const expectedExtension =
    contentType && rule.contentTypes.includes(contentType)
      ? ALLOWED_CONTENT_TYPES[contentType]
      : undefined;

  if (!expectedExtension || !key.endsWith(`.${expectedExtension}`)) {
    await deleteFile(fileUrl);
    throw new ValidationError(`The ${label} must be ${rule.typesLabel}.`);
  }
  if (sizeBytes <= 0 || sizeBytes > rule.maxBytes) {
    await deleteFile(fileUrl);
    throw new ValidationError(`The ${label} must be ${sizeLabel(rule.maxBytes)} or smaller.`);
  }

  const start = await r2.send(
    new GetObjectCommand({ Bucket: R2_BUCKET, Key: key, Range: "bytes=0-15" })
  );
  const bytes = Buffer.from((await start.Body?.transformToByteArray()) ?? []);
  if (!contentMatches(contentType!, bytes)) {
    await deleteFile(fileUrl);
    throw new ValidationError(
      `The ${label} is not really ${rule.typesLabel}. Please upload the correct file.`
    );
  }

  return { fileUrl, contentType: contentType!, sizeBytes };
}
