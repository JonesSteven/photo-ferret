// Writes the static site to site/ (SITE_DIR): the gallery page, data.json, the published photos' thumb and
// display images, and _headers. Deploy it with npm run deploy; check it first at /preview/ in the admin or
// with npm run preview-site. Doesn't call Jev.
//
// Images are named by their image number and a hash of their contents (img/12/thumb.1a2b3c4d.webp), so
// they can be cached for a year and a rebuilt image gets a new name. Only new names are copied; images of
// photos that were unpublished or deleted are removed. Never jev.jpg, never originals.
//
// SITE_IMAGE_BASE: where the page loads images from (default "img/", inside the site). Set it to another
// address (for example a Cloudflare R2 bucket's) to host the images there: they are then written to
// site-images/ for uploading, and left out of the site.
//
// Usage: npm run export-site
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "vite";
import { listPhotos } from "../server/db.ts";
import { buildSiteData, SITE_DIR, type SiteImage } from "../server/siteData.ts";
import { buildDerived, derivedExists, derivedPath } from "../server/storage.ts";

const BUILD_DIR = path.resolve(".site-build");
const IMAGE_BASE = process.env.SITE_IMAGE_BASE || "img/";
const IMAGES_INSIDE = IMAGE_BASE === "img/";
const IMG_DIR = IMAGES_INSIDE ? path.join(SITE_DIR, "img") : path.resolve("site-images");
// Cloudflare's limits for static assets on the free plan (checked 2026-10-19).
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const KINDS: SiteImage[] = ["thumb", "display"];

// 1. The gallery page alone (vite.config.ts, mode "site").
await build({ mode: "site", logLevel: "warn" });
await mkdir(SITE_DIR, { recursive: true });
await rm(path.join(SITE_DIR, "assets"), { recursive: true, force: true });
await cp(BUILD_DIR, SITE_DIR, { recursive: true });

// 2. Each published photo's images, by number and content hash.
const hash8 = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex").slice(0, 8);
const images = new Map<string, { from: string; name: string }>(); // `${id}:${kind}` → source and site path
for (const p of listPhotos({ publicOnly: true }))
  for (const kind of KINDS) {
    if (!(await derivedExists(p.id, kind))) await buildDerived(p.id, p.original_ext); // rebuilt from the original
    const from = derivedPath(p.id, kind);
    images.set(`${p.id}:${kind}`, { from, name: `${p.seq}/${kind}.${await hash8(from)}.webp` });
  }

const { data } = buildSiteData((p, kind) => IMAGE_BASE + images.get(`${p.id}:${kind}`)!.name);
const json = JSON.stringify(data);
await writeFile(path.join(SITE_DIR, "data.json"), json);

// The site title in the page itself, not only set by its script: link previews and search engines read
// the HTML without running it.
const page = path.join(SITE_DIR, "index.html");
const title = escapeHtml(data.settings.siteTitle);
await writeFile(
  page,
  (await readFile(page, "utf8"))
    .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
    .replace(/(<h1 class="brand">)[^<]*(<\/h1>)/, `$1${title}$2`),
);

let copied = 0;
const wanted = new Set<string>();
for (const { from, name } of images.values()) {
  const to = path.join(IMG_DIR, name);
  wanted.add(to);
  if (await exists(to)) continue;
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to);
  copied++;
}
let removed = 0;
for (const file of await walk(IMG_DIR))
  if (!wanted.has(file)) {
    await rm(file);
    removed++;
  }
await removeEmptyDirs(IMG_DIR);
if (!IMAGES_INSIDE) await rm(path.join(SITE_DIR, "img"), { recursive: true, force: true });

// 3. Caching: images and the hashed scripts and styles never change under their names; the page and its
// data are checked on every visit.
await writeFile(
  path.join(SITE_DIR, "_headers"),
  ["/img/*", "/assets/*"].map((p) => `${p}\n  Cache-Control: public, max-age=31536000, immutable\n`).join("") +
    ["/", "/index.html", "/data.json"].map((p) => `${p}\n  Cache-Control: public, max-age=0, must-revalidate\n`).join(""),
);

// 4. Report, with Cloudflare's limits.
const files = await walk(SITE_DIR);
let largest = { file: "", bytes: 0 };
for (const f of files) {
  const { size } = await stat(f);
  if (size > largest.bytes) largest = { file: f, bytes: size };
}
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(`Exported ${data.photos.length} photo(s) to ${SITE_DIR}`);
console.log(`  data.json ${mb(Buffer.byteLength(json))}; images copied ${copied}, removed ${removed}${IMAGES_INSIDE ? "" : ` (in ${IMG_DIR}, served from ${IMAGE_BASE})`}`);
console.log(`  ${files.length} file(s) in the site; largest ${path.relative(SITE_DIR, largest.file)} (${mb(largest.bytes)})`);
if (files.length > MAX_FILES * 0.9) console.warn(`  Warning: near or over Cloudflare's ${MAX_FILES} file limit. Consider SITE_IMAGE_BASE (R2).`);
if (largest.bytes > MAX_FILE_BYTES) console.warn(`  Warning: ${largest.file} is over Cloudflare's 25 MB file limit.`);

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

async function exists(file: string) {
  return stat(file).then(
    () => true,
    () => false,
  );
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

async function removeEmptyDirs(dir: string) {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => []))
    if (e.isDirectory()) {
      const sub = path.join(dir, e.name);
      await removeEmptyDirs(sub);
      if (!(await readdir(sub)).length) await rmdir(sub);
    }
}
