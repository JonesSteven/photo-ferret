import sharp, { type Metadata } from "sharp";

// Removes potentially sensitive metadata from an uploaded photo before it is stored, so the album never
// holds it: GPS location, camera and lens serial numbers, owner and contact fields, maker notes, embedded
// preview thumbnails (which can show the uncropped original), XMP (edit history, document IDs, original
// paths) and IPTC/Photoshop blocks. Kept: the colour profile, the orientation and the date taken
// (EXIF DateTimeOriginal, used to sort "Newest first").
//
// JPEG: lossless. Only metadata segments are dropped; the compressed image data is copied unchanged and a
// minimal EXIF block (orientation, date taken) is written in place of the original one.
// PNG: re-saved without metadata (lossless).
// Anything else (HEIC, RAW, WebP, TIFF, …): converted to a high-quality JPEG, as there's no reliable way to
// strip those formats in place.

export interface CleanedImage {
  data: Buffer;
  ext: string;
  mime: string;
}

export class CleanImageError extends Error {}

export async function cleanImage(input: Buffer, takenAt: string | null): Promise<CleanedImage> {
  let meta: Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch {
    throw new CleanImageError("That file isn't an image we can read. Try a JPEG or PNG.");
  }
  if (meta.format === "jpeg") return { data: cleanJpeg(input, meta.orientation ?? 1, takenAt), ext: "jpg", mime: "image/jpeg" };
  // sharp drops metadata unless asked to keep it; keep the colour profile, and the date taken.
  const exif = takenAt ? { IFD2: { DateTimeOriginal: exifDate(takenAt) } } : undefined;
  try {
    if (meta.format === "png") {
      const data = await sharp(input).keepIccProfile().withExif(exif ?? {}).png({ compressionLevel: 9 }).toBuffer();
      return { data, ext: "png", mime: "image/png" };
    }
    // Orientation is applied to the pixels, so it needn't be stored.
    const data = await sharp(input, { pages: 1 }).rotate().keepIccProfile().withExif(exif ?? {}).jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
    return { data, ext: "jpg", mime: "image/jpeg" };
  } catch {
    throw new CleanImageError(
      meta.format === "heif"
        ? "HEIC photos aren't supported here. Export it as JPEG (on iPhone: Settings → Camera → Formats → Most Compatible) and try again."
        : `Couldn't read this ${meta.format ?? "image"} file to remove its metadata. Try exporting it as JPEG or PNG.`,
    );
  }
}

// "YYYY-MM-DDTHH:MM:SS" (as stored) → EXIF's "YYYY:MM:DD HH:MM:SS".
const exifDate = (takenAt: string) => takenAt.replace(/^(\d{4})-(\d{2})-(\d{2})T/, "$1:$2:$3 ");

// Segments kept as they are: JFIF header (APP0), colour profile (APP2 "ICC_PROFILE"), Adobe colour
// transform (APP14 "Adobe", needed to decode some CMYK/YCC files), and every non-APP marker (tables,
// frame headers). Every other APPn (EXIF, XMP, IPTC/Photoshop, maker data, multi-picture previews) and
// comments are dropped.
function keepSegment(marker: number, body: Buffer) {
  const id = (s: string) => body.subarray(0, s.length).toString("latin1") === s;
  if (marker === 0xe0) return id("JFIF\0") || id("JFXX\0");
  if (marker === 0xe2) return id("ICC_PROFILE\0");
  if (marker === 0xee) return id("Adobe");
  if (marker >= 0xe1 && marker <= 0xef) return false;
  return marker !== 0xfe; // COM
}

export function cleanJpeg(input: Buffer, orientation: number, takenAt: string | null): Buffer {
  if (input[0] !== 0xff || input[1] !== 0xd8) throw new CleanImageError("That JPEG file is damaged.");
  const kept: Buffer[] = [];
  let jfif: Buffer | null = null;
  let i = 2;
  for (;;) {
    while (input[i] === 0xff && input[i + 1] === 0xff) i++; // fill bytes
    if (input[i] !== 0xff || i + 4 > input.length) throw new CleanImageError("That JPEG file is damaged.");
    const marker = input[i + 1]!;
    if (marker === 0xda) break; // start of scan: the image data follows
    const len = input.readUInt16BE(i + 2);
    const segment = input.subarray(i, i + 2 + len);
    if (keepSegment(marker, segment.subarray(4))) {
      if (marker === 0xe0 && !jfif) jfif = segment;
      else kept.push(segment);
    }
    i += 2 + len;
  }
  // The image data runs to the first end-of-image marker; anything after it (extra preview images that
  // some cameras append) is dropped. FF D9 can't occur inside the compressed data.
  const end = input.indexOf(Buffer.from([0xff, 0xd9]), i);
  const scan = input.subarray(i, end < 0 ? input.length : end + 2);
  const exif = minimalExif(orientation, takenAt);
  return Buffer.concat([input.subarray(0, 2), ...(jfif ? [jfif] : []), ...(exif ? [exif] : []), ...kept, scan]);
}

// An APP1 EXIF segment with only Orientation (when not upright) and DateTimeOriginal (when known), or
// null when there's neither. Little-endian TIFF: IFD0 at 8, then the Exif sub-IFD, then the date text.
function minimalExif(orientation: number, takenAt: string | null): Buffer | null {
  const rotate = orientation >= 2 && orientation <= 8;
  if (!rotate && !takenAt) return null;
  const ifd0Count = (rotate ? 1 : 0) + (takenAt ? 1 : 0);
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const exifIfdAt = 8 + ifd0Size;
  const dateAt = exifIfdAt + 2 + 12 + 4;
  const tiff = Buffer.alloc(takenAt ? dateAt + 20 : 8 + ifd0Size);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  let p = 8;
  tiff.writeUInt16LE(ifd0Count, p);
  p += 2;
  if (rotate) {
    tiff.writeUInt16LE(0x0112, p); // Orientation, SHORT × 1, value in place
    tiff.writeUInt16LE(3, p + 2);
    tiff.writeUInt32LE(1, p + 4);
    tiff.writeUInt16LE(orientation, p + 8);
    p += 12;
  }
  if (takenAt) {
    tiff.writeUInt16LE(0x8769, p); // Exif sub-IFD pointer, LONG × 1
    tiff.writeUInt16LE(4, p + 2);
    tiff.writeUInt32LE(1, p + 4);
    tiff.writeUInt32LE(exifIfdAt, p + 8);
    p += 12;
  }
  tiff.writeUInt32LE(0, p); // no next IFD (and so no embedded thumbnail)
  if (takenAt) {
    tiff.writeUInt16LE(1, exifIfdAt);
    tiff.writeUInt16LE(0x9003, exifIfdAt + 2); // DateTimeOriginal, ASCII × 20
    tiff.writeUInt16LE(2, exifIfdAt + 4);
    tiff.writeUInt32LE(20, exifIfdAt + 6);
    tiff.writeUInt32LE(dateAt, exifIfdAt + 10);
    tiff.writeUInt32LE(0, exifIfdAt + 14);
    tiff.write(`${exifDate(takenAt)}\0`, dateAt, "latin1");
  }
  const header = Buffer.from("Exif\0\0", "latin1");
  const segment = Buffer.alloc(4);
  segment.writeUInt16BE(0xffe1, 0);
  segment.writeUInt16BE(2 + header.length + tiff.length, 2);
  return Buffer.concat([segment, header, tiff]);
}
