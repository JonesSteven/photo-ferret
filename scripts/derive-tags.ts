// Re-applies the "In the photo" rules to every photo's stored Jev result (the presence thresholds and
// close-look settings in PRESENCE) and the single-answer categories (CHOICES, e.g. dropped options).
// Doesn't call Jev. Tags whose question a photo was never asked stay unknown. Usage: npm run derive-tags
import type { ClassifyResult } from "../shared/types.ts";
import { listPhotos, saveMeasured, updatePhoto } from "../server/db.ts";
import { choiceAttributes, presenceAttributes, reapplyPresence } from "../server/jev.ts";
import { CHOICES } from "../server/questions.ts";

let ok = 0;
for (const photo of listPhotos({ publicOnly: false })) {
  if (!photo.jev_result) continue;
  const result = reapplyPresence(JSON.parse(photo.jev_result) as ClassifyResult);
  const presence = presenceAttributes(result);
  saveMeasured(photo.id, [...presence, ...choiceAttributes(result)], [...presence.map((a) => a.attr), ...CHOICES.map((c) => c.id)]);
  updatePhoto(photo.id, { jev_result: JSON.stringify(result) });
  ok++;
}
console.log(`Re-derived the "In the photo" tags and the categories for ${ok} photo(s).`);
