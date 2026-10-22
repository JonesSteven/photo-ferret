import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp, { type ResizeOptions } from "sharp";
import { type CleanedImage, cleanImage } from "./cleanImage.ts";
import { ImagePrepError, prepareImage } from "./imagePrep.ts";

// Originals are stored with sensitive metadata removed (cleanImage.ts) and not changed after that; everything
// in derived/ can be rebuilt from them.
export const DATA_DIR = path.resolve(process.env.DATA_DIR || "data");
export const TMP_DIR = path.join(DATA_DIR, "tmp");
const ORIGINALS_DIR = path.join(DATA_DIR, "originals");
const DERIVED_DIR = path.join(DATA_DIR, "derived");

export const DERIVED = {
  thumb: { file: "thumb.webp", maxSide: 800, type: "image/webp" },
  display: { file: "display.webp", maxSide: 2048, type: "image/webp" },
  jev: { file: "jev.jpg", maxSide: null, type: "image/jpeg" }, // the exact JPEG sent to Jev
} as const;
export type DerivedKind = keyof typeof DERIVED;

export const originalPath = (id: string, ext: string) => path.join(ORIGINALS_DIR, `${id}.${ext}`);
export const derivedPath = (id: string, kind: DerivedKind) => path.join(DERIVED_DIR, id, DERIVED[kind].file);

export async function sha256File(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

// Stores an upload's original with its sensitive metadata removed (see cleanImage.ts), so the album never
// holds GPS locations, serial numbers, names or hidden previews. Returns the stored format and size.
export async function storeOriginal(tmpFile: string, id: string): Promise<CleanedImage> {
  const input = await readFile(tmpFile);
  const cleaned = await cleanImage(input, exifTakenAt((await sharp(input).metadata()).exif));
  await mkdir(ORIGINALS_DIR, { recursive: true });
  await writeFile(originalPath(id, cleaned.ext), cleaned.data);
  return cleaned;
}

// The public names: "Image 12", and "Image_12.jpg" for downloads.
export const publicName = (seq: number) => `Image ${seq}`;
export const publicFileName = (seq: number, ext: string) => `Image_${seq}.${ext}`;

export interface DerivedInfo {
  width: number; // upright original dimensions
  height: number;
  takenAt: string | null; // EXIF DateTimeOriginal, see exifTakenAt
  fingerprint: Fingerprint;
}

// What duplicates.ts compares photos by (all greyscale, one byte per pixel):
// - grid: GRID×GRID, stretched to a square, for near-identical frames;
// - dhash: 64-bit difference hash (hex), a cheap first test across the whole album;
// - strip: the shape kept, shorter side STRIP_SIDE, for panoramas whose stitches differ in crop and width.
export const FINGERPRINT_GRID = 64;
export const FINGERPRINT_STRIP_SIDE = 32;
export interface Fingerprint {
  dhash: string;
  grid: Uint8Array;
  strip: Uint8Array;
  stripWidth: number;
  stripHeight: number;
}

const grey = (image: Buffer, resize: ResizeOptions) =>
  sharp(image).flatten({ background: "#000" }).greyscale().resize(resize).raw().toBuffer({ resolveWithObject: true });

export async function fingerprint(image: Buffer): Promise<Fingerprint> {
  const { data: grid } = await grey(image, { width: FINGERPRINT_GRID, height: FINGERPRINT_GRID, fit: "fill" });
  const { data: d } = await grey(image, { width: 9, height: 8, fit: "fill" });
  let dhash = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) dhash = (dhash << 1n) | (d[y * 9 + x]! < d[y * 9 + x + 1]! ? 1n : 0n);
  const { width = 1, height = 1 } = await sharp(image).metadata();
  const side = FINGERPRINT_STRIP_SIDE;
  const { data: strip, info } = await grey(image, width >= height ? { height: side } : { width: side });
  return { dhash: dhash.toString(16).padStart(16, "0"), grid, strip, stripWidth: info.width, stripHeight: info.height };
}

// The capture time from a raw EXIF block (as sharp's metadata().exif returns it): DateTimeOriginal (tag
// 0x9003 in the Exif sub-IFD), "YYYY:MM:DD HH:MM:SS", returned as "YYYY-MM-DDTHH:MM:SS". Null when the
// block is missing, unreadable or has no usable date (cameras write "0000:00:00 00:00:00" when unset).
export function exifTakenAt(exif: Buffer | undefined): string | null {
  if (!exif) return null;
  // The TIFF header ("II*\0" or "MM\0*"), after an optional "Exif\0\0" prefix.
  const start = exif.subarray(0, 4).toString("latin1") === "Exif" ? 6 : 0;
  const order = exif.subarray(start, start + 2).toString("latin1");
  if (order !== "II" && order !== "MM") return null;
  const le = order === "II";
  const u16 = (o: number) => (le ? exif.readUInt16LE(start + o) : exif.readUInt16BE(start + o));
  const u32 = (o: number) => (le ? exif.readUInt32LE(start + o) : exif.readUInt32BE(start + o));
  // Finds `tag` in the IFD at `ifd` and returns its value field's offset (from the TIFF header).
  const find = (ifd: number, tag: number) => {
    const n = u16(ifd);
    for (let i = 0; i < n; i++) if (u16(ifd + 2 + i * 12) === tag) return ifd + 2 + i * 12 + 8;
    return null;
  };
  try {
    const exifIfd = find(u32(4), 0x8769);
    const date = exifIfd == null ? null : find(u32(exifIfd), 0x9003);
    if (date == null) return null;
    const text = exif.subarray(start + u32(date), start + u32(date) + 19).toString("latin1");
    const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text);
    return m && m[1] !== "0000" ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null;
  } catch {
    return null; // offsets pointing outside the block
  }
}

// Builds thumb, display and Jev images from the original. Derived images are upright and carry no metadata.
export async function buildDerived(id: string, ext: string): Promise<DerivedInfo> {
  const input = await readFile(originalPath(id, ext));
  const jev = await prepareImage(input); // throws ImagePrepError with a friendly message for undecodable files
  const meta = await sharp(input).metadata();

  const dir = path.join(DERIVED_DIR, id);
  await mkdir(dir, { recursive: true });
  for (const kind of ["thumb", "display"] as const) {
    const side = DERIVED[kind].maxSide;
    await sharp(input, { pages: 1 })
      .rotate()
      .resize({ width: side, height: side, fit: "inside", withoutEnlargement: true })
      .webp({ quality: kind === "thumb" ? 78 : 85 })
      .toFile(derivedPath(id, kind));
  }
  await writeFile(derivedPath(id, "jev"), jev.jpeg);

  return {
    width: meta.autoOrient?.width ?? meta.width ?? jev.width,
    height: meta.autoOrient?.height ?? meta.height ?? jev.height,
    takenAt: exifTakenAt(meta.exif),
    fingerprint: await fingerprint(await readFile(derivedPath(id, "thumb"))),
  };
}

// Colour warmth from the pixels, 0 (cool) to 100 (warm): red minus blue relative to their mean.
// The experiment's photos spanned roughly ±50 on the raw index, which is mapped onto 0–100.
export async function pixelWarmth(jpeg: Buffer) {
  const { channels } = await sharp(jpeg).stats();
  const r = channels[0]?.mean ?? 0;
  const b = channels[2]?.mean ?? 0;
  if (r + b < 8) return 50; // (near-)black: no meaningful colour, so neutral rather than an unstable ratio
  const index = ((r - b) / ((r + b) / 2)) * 100;
  return Math.round(Math.max(0, Math.min(100, 50 + index)) * 10) / 10;
}

// HSV for one pixel of a raw RGB buffer: hue in degrees (0–360), saturation and value in 0–1.
function hsv(data: Buffer, i: number) {
  const r = data[i]! / 255, g = data[i + 1]! / 255, b = data[i + 2]! / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  const h = d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: max === 0 ? 0 : d / max, v: max };
}

const small = (jpeg: Buffer) => sharp(jpeg).resize(128, 128, { fit: "inside" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });

// Brightness, 0 (low-key) to 100 (high-key): mean luminance of the sRGB pixels (Rec. 709 weights).
export async function pixelBrightness(jpeg: Buffer) {
  const { data } = await small(jpeg);
  let sum = 0;
  for (let i = 0; i < data.length; i += 3) sum += 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
  return Math.round((sum / (data.length / 3) / 255) * 1000) / 10;
}

// Saturation, 0 (muted) to 100 (vivid): mean HSV saturation. Natural photos rarely average above 0.6,
// so 0–0.6 is mapped onto 0–100.
export const SATURATION_FULL = 0.6;
export async function pixelSaturation(jpeg: Buffer) {
  const { data } = await small(jpeg);
  let sum = 0;
  for (let i = 0; i < data.length; i += 3) {
    const { s, v } = hsv(data, i);
    sum += v < 0.08 ? 0 : s; // hue and saturation are noise in near-black pixels
  }
  return Math.round(Math.min(100, (sum / (data.length / 3) / SATURATION_FULL) * 100) * 10) / 10;
}

// Palette: the one or two colour families covering the most pixels, as option ids from PALETTE in
// questions.ts. Grey and weakly coloured pixels count as "neutral". Near-black (shadows) and blown-out
// near-white pixels (the sun, glare) count as nothing. Neutral was on 82% of photos as a plain family, so:
// its share is divided by NEUTRAL_DIV before ranking (it must cover over 4× the top colour to come first),
// and it is never the second chip.
const HUE_FAMILIES: [number, string][] = [
  [15, "red"],
  [40, "orange"],
  [70, "yellow"],
  [160, "green"],
  [195, "teal"],
  [255, "blue"],
  [290, "purple"],
  [345, "pink"],
  [360, "red"],
];
const NEUTRAL_DIV = 4;
const NEAR_BLACK = 0.12; // brightest channel below this
const NEAR_WHITE = 0.95; // every channel at or above this
export async function pixelPalette(jpeg: Buffer) {
  const { data } = await small(jpeg);
  const counts = new Map<string, number>();
  let n = 0;
  for (let i = 0; i < data.length; i += 3) {
    const { h, s, v } = hsv(data, i);
    if (v < NEAR_BLACK || Math.min(data[i]!, data[i + 1]!, data[i + 2]!) / 255 >= NEAR_WHITE) continue;
    n++;
    const family = s < 0.2 ? "neutral" : HUE_FAMILIES.find(([end]) => h < end)![1];
    counts.set(family, (counts.get(family) ?? 0) + (family === "neutral" ? 1 / NEUTRAL_DIV : 1));
  }
  // Almost nothing left (a black or white frame): neutral.
  if (n < (data.length / 3) * 0.05) return "neutral";
  const [first, ...rest] = [...counts].sort((a, b) => b[1] - a[1]);
  // The second chip: the next colour (never neutral) when it covers at least 15% of the counted pixels.
  const second = rest.find(([id]) => id !== "neutral");
  return [first![0], ...(second && second[1] / n >= 0.15 ? [second[0]] : [])].join(",");
}

const COLOURED_MIN_SHARE = 0.1;

// Main colour, as a position 0–100 on a hue axis that runs red → orange → yellow → green → teal → blue →
// purple → pink (the hue wheel turned 15° so red isn't split across the ends): the colour family covering
// the most pixels (the palette's "coloured" test) and its mean hue. A forest under a blue sky is green.
// NaN (neutral, stored as unknown) when under 10% of the frame is coloured.
export async function pixelMainHue(jpeg: Buffer) {
  const { data } = await small(jpeg);
  const count = new Map<string, number>();
  const hueSum = new Map<string, number>();
  let coloured = 0;
  for (let i = 0; i < data.length; i += 3) {
    const { h, s, v } = hsv(data, i);
    if (s < 0.2 || v < 0.12) continue;
    coloured++;
    const family = HUE_FAMILIES.find(([end]) => h < end)![1];
    count.set(family, (count.get(family) ?? 0) + 1);
    hueSum.set(family, (hueSum.get(family) ?? 0) + ((h + 15) % 360));
  }
  if (coloured / (data.length / 3) < COLOURED_MIN_SHARE) return NaN;
  const [family, n] = [...count].sort((a, b) => b[1] - a[1])[0]!;
  return Math.round(((hueSum.get(family)! / n) / 360) * 1000) / 10;
}

// Everything measured in code rather than asked of Jev. A measure that fails is left out (unknown), never 0.
export async function computedAttributes(jpeg: Buffer) {
  const measures: [string, () => Promise<number | string>][] = [
    ["warmth", () => pixelWarmth(jpeg)],
    ["saturation", () => pixelSaturation(jpeg)],
    ["brightness", () => pixelBrightness(jpeg)],
    ["palette", () => pixelPalette(jpeg)],
    ["main_hue", () => pixelMainHue(jpeg)],
  ];
  const out: { attr: string; value: string; confidence: null }[] = [];
  for (const [attr, measure] of measures) {
    try {
      const value = String(await measure());
      if (value !== "" && value !== "NaN") out.push({ attr, value, confidence: null });
    } catch (err) {
      console.error(`[measure] ${attr}`, err);
    }
  }
  return out;
}

export async function derivedExists(id: string, kind: DerivedKind) {
  return stat(derivedPath(id, kind)).then(
    () => true,
    () => false,
  );
}

export async function removePhotoFiles(id: string, ext: string) {
  await rm(originalPath(id, ext), { force: true });
  await rm(path.join(DERIVED_DIR, id), { recursive: true, force: true });
}

export { ImagePrepError };
