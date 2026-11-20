import { crc32, deflateSync } from "node:zlib";
import QRCode from "qrcode";

/**
 * QR pictures for printing (Module 7 T4, DEC-123).
 * - Highest damage tolerance (error-correction level H: still readable with ~30% damaged).
 * - The standard quiet zone of 4 white squares around the pattern.
 * - PNG: 1000 × 1000, pure black and white (1 bit per pixel). Written here directly from
 *   the QR pattern because the `qrcode` package's own PNG writer takes ~0.1 s per image
 *   at this size (17 minutes for 10,000); this takes about 1 ms.
 * - SVG: from the `qrcode` package (fast); sharp at any size.
 */

const ERROR_CORRECTION = "H";
const QUIET_ZONE = 4;
export const QR_PNG_SIZE = 1000;

/** The QR pattern: `size` × `size` squares, `dark(row, col)` true for black. */
function qrPattern(text: string) {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: ERROR_CORRECTION });
  return { size: modules.size, dark: (row: number, col: number) => modules.get(row, col) === 1 };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * A 1000 × 1000 black-and-white PNG of the QR for `text`.
 * Each square is a whole number of pixels (no blurry edges); the pattern is centred and
 * the few pixels left over join the white border.
 */
export function qrPng(text: string): Buffer {
  const { size, dark } = qrPattern(text);
  const squares = size + QUIET_ZONE * 2;
  const scale = Math.floor(QR_PNG_SIZE / squares);
  const offset = Math.floor((QR_PNG_SIZE - squares * scale) / 2) + QUIET_ZONE * scale;

  // One PNG row = 1 filter byte (0 = none) + 1 bit per pixel; bit 1 = white, 0 = black.
  const rowBytes = 1 + Math.ceil(QR_PNG_SIZE / 8);
  const whiteRow = Buffer.alloc(rowBytes, 0xff);
  whiteRow[0] = 0;

  // Every pixel row inside one row of squares is the same, so each is built once.
  const patternRows: Buffer[] = [];
  for (let row = 0; row < size; row++) {
    const line = Buffer.from(whiteRow);
    for (let col = 0; col < size; col++) {
      if (!dark(row, col)) continue;
      const startX = offset + col * scale;
      for (let x = startX; x < startX + scale; x++) {
        line[1 + (x >> 3)]! &= ~(0x80 >> (x & 7));
      }
    }
    patternRows.push(line);
  }

  const raw = Buffer.alloc(rowBytes * QR_PNG_SIZE);
  for (let y = 0; y < QR_PNG_SIZE; y++) {
    const row = Math.floor((y - offset) / scale);
    const source = y >= offset && row < size ? patternRows[row]! : whiteRow;
    source.copy(raw, y * rowBytes);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(QR_PNG_SIZE, 0); // width
  header.writeUInt32BE(QR_PNG_SIZE, 4); // height
  header[8] = 1; // 1 bit per pixel
  header[9] = 0; // greyscale
  header[10] = 0; // compression: deflate
  header[11] = 0; // filter method
  header[12] = 0; // no interlace

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** An SVG of the QR for `text`; sharp at any size. */
export function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, {
    type: "svg",
    errorCorrectionLevel: ERROR_CORRECTION,
    margin: QUIET_ZONE,
    width: QR_PNG_SIZE,
  });
}
