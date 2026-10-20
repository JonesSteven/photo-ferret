// Scores the overall quality (1–100) of photos without a score, asking Jev only that question, of the same
// image as their tagging run; --force rescores every photo, which is needed after changing the question.
// Writes only the quality value: other tags, overrides (including a quality override) and the photo's
// classification date are left alone. Costs one Jev request per photo (one per tile for a panorama).
// New photos are scored by the normal classification request.
// Usage: npm run score-quality [-- --force]
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import type { ClassifyResult, ScoreReading } from "../shared/types.ts";
import { attributesFor, listPhotos, saveMeasured, updatePhoto } from "../server/db.ts";
import { cropTiles, fitsJev, panoramaGrid, type PreparedImage } from "../server/imagePrep.ts";
import { askQuality, describeJevError, hasApiKey, mergeQuality, qualityAttributes } from "../server/jev.ts";
import { QUALITY } from "../server/questions.ts";
import { derivedPath, originalPath, publicName } from "../server/storage.ts";

if (!hasApiKey()) {
  console.error("TYPESAFE_API_KEY is not set.");
  process.exit(1);
}
const force = process.argv.includes("--force");

const photos = listPhotos({ publicOnly: false }).filter((p) => p.jev_status === "done");
const attrs = attributesFor(photos.map((p) => p.id));
const todo = photos.filter((p) => force || attrs.get(p.id)?.find((a) => a.attr === QUALITY.id)?.jevValue == null);
console.log(`${todo.length} of ${photos.length} classified photo(s) to score${force ? " (--force)" : ""}.`);

let inputTokens = 0;
let outputTokens = 0;
let failed = 0;
for (const [i, photo] of todo.entries()) {
  const label = `${i + 1}/${todo.length} ${publicName(photo.seq)}`;
  try {
    const jpeg = await readFile(derivedPath(photo.id, "jev"));
    const { width = 0, height = 0 } = await sharp(jpeg).metadata();
    // Panoramas: the same overlapping tiles of the original as their classification (classifyQueue.ts).
    const images: PreparedImage[] = fitsJev(width, height)
      ? [{ jpeg, width, height, originalFormat: photo.original_ext, resized: false, panorama: false }]
      : await cropTiles(await readFile(originalPath(photo.id, photo.original_ext)), ...panoramaGrid(width, height));
    const readings: (ScoreReading | undefined)[] = [];
    let model = "";
    for (const img of images) {
      const { reading, res } = await askQuality(img);
      readings.push(reading);
      model = res.model;
      inputTokens += res.usage.input_tokens ?? 0;
      outputTokens += res.usage.output_tokens ?? 0;
    }
    const quality = mergeQuality(readings);
    if (!quality) {
      console.log(`${label}: no score in Jev's answer; left as it was`);
      failed++;
      continue;
    }
    saveMeasured(photo.id, qualityAttributes({ quality, model }), [QUALITY.id]);
    if (photo.jev_result) {
      const result = JSON.parse(photo.jev_result) as ClassifyResult;
      updatePhoto(photo.id, { jev_result: JSON.stringify({ ...result, quality }) });
    }
    console.log(`${label} → ${quality.value}${images.length > 1 ? ` (${images.length} tiles)` : ""}`);
  } catch (err) {
    const { body } = describeJevError(err);
    console.error(`${label}: ${body.error}`, body.detail ?? "");
    failed++;
  }
}
console.log(`Scored ${todo.length - failed} photo(s); ${failed} failed. Tokens: ${inputTokens} input, ${outputTokens} output.`);
