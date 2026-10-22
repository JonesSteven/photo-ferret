// Fingerprints every photo for the duplicates view, from its stored thumbnail. New uploads get one when
// they're processed, so this is for photos added before that. Doesn't call Jev.
// Usage: npm run fingerprint (only photos without one), or npm run fingerprint -- --all
import { readFile } from "node:fs/promises";
import { allFingerprints, listPhotos, saveFingerprint } from "../server/db.ts";
import { derivedPath, fingerprint } from "../server/storage.ts";

const all = process.argv.includes("--all");
const done = all ? new Set<string>() : new Set(allFingerprints().keys());
let ok = 0;
let failed = 0;
for (const photo of listPhotos({ publicOnly: false })) {
  if (!photo.derived_ready || done.has(photo.id)) continue;
  try {
    saveFingerprint(photo.id, await fingerprint(await readFile(derivedPath(photo.id, "thumb"))));
    ok++;
  } catch (err) {
    console.error(`${photo.id} (${photo.original_name}): ${(err as Error).message}`);
    failed++;
  }
}
console.log(`Fingerprinted ${ok} photo(s); ${failed} failed.`);
