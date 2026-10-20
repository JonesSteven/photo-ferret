import sharp, { type Metadata, type OutputInfo } from "sharp";

// Documented image limits (docs.typesafe.ai/images). Images outside them are rejected, not resized,
// so we normalize here: upright pixels, each side 280..1568 px, 78,400..2,458,624 px total, baseline JPEG.
const MAX_SIDE = 1568;
const MIN_SIDE = 280;
const MIN_PIXELS = 78_400;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

export class ImagePrepError extends Error {}

export interface PreparedImage {
  jpeg: Buffer;
  width: number;
  height: number;
  originalFormat: string;
  resized: boolean;
  panorama: boolean; // too elongated for Jev's limits as one image; classified in tiles (cropTiles)
}

// True when a JPEG of this size can be sent to Jev as it is.
export const fitsJev = (w: number, h: number) => Math.min(w, h) >= MIN_SIDE && Math.max(w, h) <= MAX_SIDE && w * h >= MIN_PIXELS;

export async function prepareImage(input: Buffer): Promise<PreparedImage> {
  let meta: Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch {
    throw new ImagePrepError("That file isn't an image we can read. Try a JPEG or PNG.");
  }
  const originalFormat = meta.format ?? "unknown";

  // EXIF is stripped by the API and orientation is not applied, so bake rotation into the pixels.
  // `pages: 1` keeps only the first frame of animated GIF/WebP/PNG.
  let decoded: { data: Buffer; info: OutputInfo };
  try {
    decoded = await sharp(input, { pages: 1 })
      .rotate()
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" }) // JPEG has no alpha
      .toColourspace("srgb") // one colour space for Jev and for the pixel measurements
      .raw() // keep pixels lossless until the single JPEG encode below
      .toBuffer({ resolveWithObject: true });
  } catch {
    const heic = originalFormat === "heif";
    throw new ImagePrepError(
      heic
        ? "HEIC photos aren't supported here. Export it as JPEG (on iPhone: Settings → Camera → Formats → Most Compatible) and try again."
        : `Couldn't decode this ${originalFormat} image. Try exporting it as JPEG or PNG.`,
    );
  }

  let { width, height } = decoded.info;
  let resized = width !== (meta.autoOrient?.width ?? meta.width) || height !== (meta.autoOrient?.height ?? meta.height);

  // Upscale (never pad, so Box fractions still map onto the photo) when below the minimums.
  const scale = Math.max(1, MIN_SIDE / Math.min(width, height), Math.sqrt(MIN_PIXELS / (width * height)));
  let pipeline = sharp(decoded.data, { raw: { width, height, channels: decoded.info.channels } });
  let panorama = false;
  if (scale > 1) {
    const w = Math.ceil(width * scale);
    const h = Math.ceil(height * scale);
    if (Math.max(w, h) > MAX_SIDE) {
      // More elongated than 1568:280 (5.6:1). Keep the image as it is for display and pixel measures;
      // Jev sees it as overlapping tiles instead (see cropTiles and classifyQueue).
      panorama = true;
    } else {
      pipeline = pipeline.resize({ width: w, height: h, fit: "fill" });
      width = w;
      height = h;
      resized = true;
    }
  }

  const jpeg = await pipeline.jpeg({ quality: 90, progressive: false, mozjpeg: false }).toBuffer();
  if (jpeg.length > MAX_IMAGE_BYTES) throw new ImagePrepError("The processed image is over 16 MiB.");
  return { jpeg, width, height, originalFormat, resized, panorama };
}

// Splits an image into a cols × rows grid of overlapping tiles, each scaled to fit Jev's limits. Used for
// panoramas (a row of tiles) and for the close look at small subjects (2 × 2 on the original).
export async function cropTiles(input: Buffer, cols: number, rows: number, overlap = 0.1): Promise<PreparedImage[]> {
  const { data, info } = await sharp(input, { pages: 1 })
    .rotate()
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const tw = cols > 1 ? Math.min(W, (W / cols) * (1 + overlap)) : W;
  const th = rows > 1 ? Math.min(H, (H / rows) * (1 + overlap)) : H;
  // Fit the longer tile side under the maximum; then lift the shorter side to the minimum if needed.
  let s = Math.min(1, MAX_SIDE / Math.max(tw, th));
  s = Math.max(s, MIN_SIDE / Math.min(tw, th), Math.sqrt(MIN_PIXELS / (tw * th)));
  if (Math.max(tw, th) * s > MAX_SIDE + 0.5) throw new ImagePrepError(`Can't tile this ${W}×${H} image within Jev's limits.`);
  const SW = Math.round(W * s);
  const SH = Math.round(H * s);
  const w = Math.min(SW, Math.round(tw * s));
  const h = Math.min(SH, Math.round(th * s));
  const scaled = await sharp(data, { raw: { width: W, height: H, channels: info.channels } }).resize({ width: SW, height: SH, fit: "fill" }).raw().toBuffer();
  const tiles: PreparedImage[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const left = cols > 1 ? Math.round((c * (SW - w)) / (cols - 1)) : 0;
      const top = rows > 1 ? Math.round((r * (SH - h)) / (rows - 1)) : 0;
      const jpeg = await sharp(scaled, { raw: { width: SW, height: SH, channels: info.channels } })
        .extract({ left, top, width: w, height: h })
        .jpeg({ quality: 90, progressive: false, mozjpeg: false })
        .toBuffer();
      tiles.push({ jpeg, width: w, height: h, originalFormat: "tile", resized: true, panorama: false });
    }
  }
  return tiles;
}

// Tiles for a panorama: enough overlapping tiles along its long side that none is more elongated than 3:1.
export function panoramaGrid(w: number, h: number): [number, number] {
  const n = Math.max(2, Math.ceil((Math.max(w, h) / Math.min(w, h)) * 1.1 / 3));
  return w >= h ? [n, 1] : [1, n];
}
