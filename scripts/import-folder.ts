// Imports every image in a folder through the running local server's admin upload, in batches of 50 (the
// upload limit), so each photo is cleaned, numbered, de-duplicated and queued for Jev exactly as an upload
// from the admin. Files are sent in name order, which becomes the image numbers (0001.jpg → Image 1 on an
// empty album). Files whose name is already in the album are skipped, so an interrupted import can simply
// be run again. Each new photo costs Jev requests; --limit N imports only the next N (for a trial run).
// Needs the server running (npm run dev) and ADMIN_USER / ADMIN_PASSWORD from .env.
// Usage: npm run import-folder -- <folder> [--limit N]
import { openAsBlob } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { AdminPhoto, UploadResult } from "../shared/types.ts";

const BATCH = 50; // MAX_FILES_PER_UPLOAD in server/index.ts
const IMAGE_EXT = /\.(jpe?g|png|webp|tiff?|heic|heif|avif|gif)$/i;
const base = `http://localhost:${process.env.PORT ?? 3001}`;

const args = process.argv.slice(2);
const limitAt = args.indexOf("--limit");
const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : Infinity;
const dir = args.find((a, i) => !a.startsWith("--") && !(limitAt >= 0 && i === limitAt + 1));
if (!dir || !(limit > 0)) {
  console.error("Usage: npm run import-folder -- <folder> [--limit N]");
  process.exit(1);
}

// Sign in once; the session cookie goes with every request.
const login = await fetch(`${base}/api/admin/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ user: process.env.ADMIN_USER, password: process.env.ADMIN_PASSWORD }),
}).catch(() => {
  console.error(`Couldn't reach the server at ${base}. Start it with npm run dev.`);
  process.exit(1);
});
if (!login.ok) {
  console.error(`Sign-in failed (${login.status}). Check ADMIN_USER and ADMIN_PASSWORD in .env.`);
  process.exit(1);
}
const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

const existing = new Set(((await (await fetch(`${base}/api/admin/photos`, { headers: { cookie } })).json()) as AdminPhoto[]).map((p) => p.originalName));
const names = (await readdir(dir, { withFileTypes: true }))
  .filter((e) => e.isFile() && IMAGE_EXT.test(e.name))
  .map((e) => e.name)
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const todo = names.filter((n) => !existing.has(n)).slice(0, limit);
console.log(`${names.length} image(s) in ${dir}; ${names.filter((n) => existing.has(n)).length} already imported; importing ${todo.length}.`);

function mimeType(name: string) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return ext === "jpg" ? "image/jpeg" : ext === "tif" ? "image/tiff" : `image/${ext}`;
}

let added = 0;
let failed = 0;
for (let i = 0; i < todo.length; i += BATCH) {
  const batch = todo.slice(i, i + BATCH);
  const form = new FormData();
  for (const name of batch) form.append("photos", await openAsBlob(path.join(dir, name), { type: mimeType(name) }), name);
  const res = await fetch(`${base}/api/admin/photos`, { method: "POST", headers: { cookie }, body: form });
  if (!res.ok) {
    console.error(`Batch ${batch[0]}–${batch.at(-1)} failed (${res.status}): ${await res.text()}`);
    process.exit(1); // stop, so the numbering stays in order; rerunning resumes here
  }
  for (const r of (await res.json()) as UploadResult[]) {
    if (r.photo) added++;
    else {
      failed++;
      console.error(`  ${r.name}: ${r.error}`);
    }
  }
  console.log(`${Math.min(i + BATCH, todo.length)}/${todo.length} sent (up to ${batch.at(-1)}).`);
}
console.log(`Imported ${added} photo(s); ${failed} rejected. Jev tags them in the background; watch the admin for progress.`);
