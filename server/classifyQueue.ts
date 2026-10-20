import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { getPhoto, listPendingIds, saveClassification, updatePhoto } from "./db.ts";
import { cropTiles, fitsJev, panoramaGrid, type PreparedImage } from "./imagePrep.ts";
import { askCloseLook, askJev, describeJevError, finalize, hasApiKey, mergeTiles, normalize, toAttributes } from "./jev.ts";
import { buildDerived, computedAttributes, derivedExists, derivedPath, ImagePrepError, originalPath } from "./storage.ts";
import { PRESENCE } from "./questions.ts";

// Background processing for uploaded photos: build derived images, then ask Jev. Kept in memory;
// rows still 'pending' after a restart are queued again by resumePending().
const CONCURRENCY = 2;
const queue: string[] = [];
const queued = new Set<string>();
let running = 0;

export function enqueue(id: string) {
  if (queued.has(id)) return;
  queued.add(id);
  queue.push(id);
  pump();
}

export function enqueueAll(ids: string[]) {
  for (const id of ids) enqueue(id);
}

export function resumePending() {
  for (const id of listPendingIds()) enqueue(id);
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const id = queue.shift()!;
    running++;
    processPhoto(id)
      .catch((err) => console.error(`[queue] ${id}`, err))
      .finally(() => {
        running--;
        queued.delete(id);
        pump();
      });
  }
}

async function processPhoto(id: string) {
  const photo = getPhoto(id);
  if (!photo) return; // deleted while queued

  if (!photo.derived_ready || !(await derivedExists(id, "jev"))) {
    try {
      const { width, height, takenAt } = await buildDerived(id, photo.original_ext);
      updatePhoto(id, { width, height, taken_at: takenAt, derived_ready: 1 });
    } catch (err) {
      if (!(err instanceof ImagePrepError)) console.error(`[derive] ${id}`, err);
      const message = err instanceof ImagePrepError ? err.message : "Couldn't process this image.";
      updatePhoto(id, { derived_ready: 0, jev_status: "error", jev_error: `${message} The original is still saved.` });
      return;
    }
  }

  if (!hasApiKey()) {
    updatePhoto(id, { jev_status: "error", jev_error: "TYPESAFE_API_KEY is not set on the server." });
    return;
  }

  // Re-runs reuse the stored Jev JPEG, so the boxes always line up with jev.jpg.
  const jpeg = await readFile(derivedPath(id, "jev"));
  const { width = 0, height = 0 } = await sharp(jpeg).metadata();
  const img: PreparedImage = { jpeg, width, height, originalFormat: photo.original_ext, resized: false, panorama: !fitsJev(width, height) };
  try {
    let result;
    if (img.panorama) {
      // Too elongated to send whole: classify overlapping tiles of the original and merge the answers.
      const original = await readFile(originalPath(id, photo.original_ext));
      const [cols, rows] = panoramaGrid(width, height);
      const parts = [];
      for (const tile of await cropTiles(original, cols, rows)) {
        const { res, elapsedMs } = await askJev(tile);
        parts.push(normalize(res.answers, tile, { model: res.model, usage: res.usage, elapsedMs }));
      }
      result = finalize(mergeTiles(parts));
    } else {
      const { res, elapsedMs } = await askJev(img);
      result = normalize(res.answers, img, { model: res.model, usage: res.usage, elapsedMs });
      // Small or distant subjects: when a presence answer is uncertain, look again at sharper tiles.
      const unsure = result.presence
        .filter((d) => d.value === "uncertain" && PRESENCE.find((x) => x.id === d.id)?.closeLook !== false)
        .map((d) => d.id);
      let closeLook: Record<string, number> | undefined;
      if (unsure.length) {
        try {
          const tiles = await cropTiles(await readFile(originalPath(id, photo.original_ext)), 2, 2);
          closeLook = (await askCloseLook(tiles.map((t) => t.jpeg), unsure)).pById;
        } catch (err) {
          const { body } = describeJevError(err);
          console.error(`[close look] ${id} ${body.error}`, body.detail ?? "");
        }
      }
      result = finalize(result, closeLook);
    }
    const computed = await computedAttributes(jpeg); // measured in code, not asked of Jev
    if (getPhoto(id)) saveClassification(id, result, [...toAttributes(result), ...computed]);
  } catch (err) {
    const { status, body } = describeJevError(err);
    console.error(`[classify] ${id} ${status} ${body.error}`, body.requestId ?? "", body.detail ?? "");
    if (getPhoto(id)) updatePhoto(id, { jev_status: "error", jev_error: body.error });
  }
}
