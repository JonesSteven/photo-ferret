// Re-measures the pixel-based tags (warmth, saturation, brightness, palette and main colour)
// for every photo from its stored Jev JPEG. Doesn't call Jev. Usage: npm run remeasure
import { readFile } from "node:fs/promises";
import { listPhotos, saveMeasured } from "../server/db.ts";
import { ATTRIBUTES } from "../server/questions.ts";
import { computedAttributes, derivedPath } from "../server/storage.ts";

const measuredIds = ATTRIBUTES.filter((a) => a.source === "computed").map((a) => a.id);
let ok = 0;
for (const photo of listPhotos({ publicOnly: false })) {
  if (!photo.derived_ready) continue;
  saveMeasured(photo.id, await computedAttributes(await readFile(derivedPath(photo.id, "jev"))), measuredIds);
  ok++;
}
console.log(`Re-measured ${ok} photo(s).`);
