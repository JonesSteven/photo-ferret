// Rebuilds thumb/display/Jev images for every photo from its stored original. Doesn't call Jev.
// Usage: npm run rebuild-derived
import { listPhotos, saveFingerprint, updatePhoto } from "../server/db.ts";
import { buildDerived } from "../server/storage.ts";

let ok = 0;
let failed = 0;
for (const photo of listPhotos({ publicOnly: false })) {
  try {
    const { width, height, takenAt, fingerprint } = await buildDerived(photo.id, photo.original_ext);
    updatePhoto(photo.id, { width, height, taken_at: takenAt, derived_ready: 1 });
    saveFingerprint(photo.id, fingerprint);
    ok++;
  } catch (err) {
    console.error(`${photo.id} (${photo.original_name}): ${(err as Error).message}`);
    failed++;
  }
}
console.log(`Rebuilt ${ok} photo(s); ${failed} failed.`);
