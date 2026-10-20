// Recomputes every photo's 1–100 quality value from its stored Jev reading (score and level
// probabilities), for example after changing the curve in server/jev.ts. Doesn't call Jev. Writes only the
// quality value: other tags and overrides (including a quality override) are left alone.
// Usage: npm run remap-quality
import type { ClassifyResult } from "../shared/types.ts";
import { listPhotos, saveMeasured, updatePhoto } from "../server/db.ts";
import { mergeQuality, qualityAttributes } from "../server/jev.ts";
import { QUALITY } from "../server/questions.ts";

let changed = 0;
let skipped = 0;
for (const photo of listPhotos({ publicOnly: false })) {
  const result = photo.jev_result ? (JSON.parse(photo.jev_result) as ClassifyResult) : undefined;
  const quality = result?.quality && mergeQuality([result.quality]);
  if (!result || !quality) {
    skipped++;
    continue;
  }
  saveMeasured(photo.id, qualityAttributes({ quality, model: result.model }), [QUALITY.id]);
  updatePhoto(photo.id, { jev_result: JSON.stringify({ ...result, quality }) });
  if (quality.value !== result.quality!.value) changed++;
}
console.log(`Remapped quality: ${changed} value(s) changed; ${skipped} photo(s) without a stored reading skipped.`);
