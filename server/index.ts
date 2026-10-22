import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { ABOUT_TEXT_MAX, type PhotoPatch, SITE_TITLE_MAX, type SiteSettings, type UploadResult } from "../shared/types.ts";
import { adminConfigured, checkLogin, clearSession, isAdmin, requireAdmin, setSession } from "./auth.ts";
import { enqueue, enqueueAll, resumePending } from "./classifyQueue.ts";
import {
  attributesFor,
  deletePhoto,
  dismissPairs,
  findBySha256,
  dataVersion,
  getPhoto,
  getPublicBySeq,
  getSettings,
  insertPhoto,
  listPhotos,
  markAllPending,
  pruneAttributes,
  saveSettings,
  setOverrides,
  updatePhoto,
} from "./db.ts";
import { duplicateReport } from "./duplicates.ts";
import { hasApiKey, JEV_MODEL } from "./jev.ts";
import { adminPhotos, toAdmin } from "./photos.ts";
import { ATTRIBUTE_IDS, ATTRIBUTES, isNumericKind, isValidAttributeValue } from "./questions.ts";
import { CleanImageError } from "./cleanImage.ts";
import { buildSiteData, SITE_DIR } from "./siteData.ts";
import { buildDerived, DERIVED, derivedExists, derivedPath, originalPath, publicFileName, removePhotoFiles, sha256File, storeOriginal, TMP_DIR } from "./storage.ts";

const PORT = Number(process.env.PORT ?? 3001);
const MAX_UPLOAD_MB = 100;
const MAX_FILES_PER_UPLOAD = 50;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Camera formats browsers often send as application/octet-stream. They are stored as originals even if
// sharp can't decode them (the photo is then marked with an error but stays downloadable).
const EXTRA_IMAGE_EXTS = new Set(["heic", "heif", "dng", "cr2", "cr3", "nef", "arw", "orf", "raf", "rw2"]);

mkdirSync(TMP_DIR, { recursive: true });
const app = express();
app.set("trust proxy", "loopback");
app.use(express.json({ limit: "100kb" }));
const upload = multer({
  dest: TMP_DIR, // same volume as originals/, so storing is a rename
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: MAX_FILES_PER_UPLOAD },
});

// Multer reports filenames as latin1; most browsers send UTF-8.
function fileName(f: Express.Multer.File) {
  const utf8 = Buffer.from(f.originalname, "latin1").toString("utf8");
  return utf8.includes("�") ? f.originalname : utf8;
}

function fileExt(name: string) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : "bin";
}

const isImage = (f: Express.Multer.File, ext: string) => f.mimetype.startsWith("image/") || EXTRA_IMAGE_EXTS.has(ext);

const param = (req: Request, name: string) => String(req.params[name]);

// ---- Public ----

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, model: JEV_MODEL, apiKeyConfigured: hasApiKey(), adminConfigured: adminConfigured() });
});

app.get("/api/attributes", (_req, res) => {
  res.json(ATTRIBUTES);
});

app.get("/api/settings", (_req, res) => {
  res.json(getSettings());
});

// ---- The gallery in dev: the same data.json and image paths as the exported site (npm run export-site) ----

let siteData: { version: string; json: string } | null = null;
app.get("/data.json", (_req, res) => {
  const version = dataVersion();
  if (siteData?.version !== version) {
    const { data } = buildSiteData((p, kind) => `img/${p.seq}/${kind}.webp`);
    siteData = { version, json: JSON.stringify(data) };
  }
  res.set("Cache-Control", "no-cache").type("json").send(siteData.json);
});

app.get("/img/:n/:file", async (req, res) => {
  const kind = /^(thumb|display)\.webp$/.exec(param(req, "file"))?.[1] as "thumb" | "display" | undefined;
  const photo = kind ? getPublicBySeq(Number(param(req, "n"))) : undefined;
  if (!kind || !photo || !(await derivedExists(photo.id, kind))) return res.status(404).end();
  res.set("Cache-Control", "no-cache").type(DERIVED[kind].type).sendFile(derivedPath(photo.id, kind));
});

// The last export, to check it before deploying (linked from the admin).
app.use("/preview", express.static(SITE_DIR, { cacheControl: false }));

// ---- Admin ----

// Images by internal id, for the admin only (the gallery uses /img above, or the export's files).
// 404 rather than 403 to not reveal them.
app.get("/media/:id/:kind", async (req, res) => {
  const photo = getPhoto(param(req, "id"));
  const kind = param(req, "kind");
  if (!photo || !isAdmin(req)) return res.status(404).end();
  res.set("Cache-Control", "no-cache"); // revalidate (cheap 304s) after rebuilds

  if (kind === "original") {
    return res.download(originalPath(photo.id, photo.original_ext), publicFileName(photo.seq, photo.original_ext));
  }
  if (!(kind in DERIVED)) return res.status(404).end();
  const k = kind as keyof typeof DERIVED;
  if (!(await derivedExists(photo.id, k))) {
    // Derived images can always be rebuilt from the original.
    try {
      await buildDerived(photo.id, photo.original_ext);
    } catch {
      return res.status(404).end();
    }
  }
  res.type(DERIVED[k].type).sendFile(derivedPath(photo.id, k));
});

app.post("/api/admin/login", async (req, res) => {
  if (!adminConfigured()) return res.status(503).json({ error: "Admin login isn't configured (set ADMIN_USER and ADMIN_PASSWORD)." });
  const { user, password } = (req.body ?? {}) as { user?: unknown; password?: unknown };
  if (typeof user !== "string" || typeof password !== "string" || !(await checkLogin(user, password))) {
    return res.status(401).json({ error: "Wrong username or password." });
  }
  setSession(req, res);
  res.json({ ok: true });
});

app.post("/api/admin/logout", (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

app.get("/api/admin/me", (req, res) => {
  res.json({ admin: isAdmin(req), configured: adminConfigured(), apiKeyConfigured: hasApiKey(), model: JEV_MODEL });
});

app.use("/api/admin", requireAdmin);

app.get("/api/admin/photos", (_req, res) => {
  res.json(adminPhotos(listPhotos({ publicOnly: false })));
});

app.post("/api/admin/photos", upload.array("photos", MAX_FILES_PER_UPLOAD), async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) return res.status(400).json({ error: "No photos uploaded (expected form field 'photos')." });

  const results: UploadResult[] = [];
  for (const f of files) {
    const name = fileName(f);
    const ext = fileExt(name);
    try {
      if (!isImage(f, ext)) {
        results.push({ name, error: "Not an image file." });
        continue;
      }
      const sha256 = await sha256File(f.path);
      const dup = findBySha256(sha256);
      if (dup) {
        results.push({ name, error: `Already uploaded (as ${dup.original_name}).` });
        continue;
      }
      const id = randomBytes(6).toString("hex");
      // The sha256 is of the file as uploaded, so uploading the same file again is still caught.
      let stored;
      try {
        stored = await storeOriginal(f.path, id);
      } catch (err) {
        if (!(err instanceof CleanImageError)) throw err;
        results.push({ name, error: err.message });
        continue;
      }
      insertPhoto({ id, original_name: name, original_ext: stored.ext, mime: stored.mime, bytes: stored.data.length, sha256 });
      enqueue(id);
      results.push({ name, photo: toAdmin(getPhoto(id)!, []) });
    } finally {
      await unlink(f.path).catch(() => {}); // already moved unless rejected
    }
  }
  res.json(results);
});

function sendAdminPhoto(res: Response, id: string) {
  const row = getPhoto(id);
  if (!row) return res.status(404).json({ error: "Photo not found." });
  res.json(toAdmin(row, attributesFor([id]).get(id) ?? []));
}

app.get("/api/admin/photos/:id", (req, res) => {
  sendAdminPhoto(res, param(req, "id"));
});

app.patch("/api/admin/photos/:id", (req, res) => {
  const id = param(req, "id");
  if (!getPhoto(id)) return res.status(404).json({ error: "Photo not found." });
  const body = (req.body ?? {}) as PhotoPatch;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 2000) : null);

  const fields: Parameters<typeof updatePhoto>[1] = {};
  if ("title" in body) fields.title = text(body.title);
  if ("description" in body) fields.description = text(body.description);
  if ("published" in body) fields.published = body.published ? 1 : 0;

  const overrides: Record<string, string | null> = {};
  for (const [attr, raw] of Object.entries(body.overrides ?? {})) {
    if (!ATTRIBUTE_IDS.has(attr)) return res.status(400).json({ error: `Unknown attribute '${attr}'.` });
    const value = raw === null || raw === undefined ? null : String(raw); // numbers may arrive as JSON numbers
    if (value !== null && !isValidAttributeValue(attr, value)) {
      return res.status(400).json({ error: `Invalid value '${value}' for '${attr}'.` });
    }
    // Numbers are stored in one canonical form so they compare and display consistently.
    const numeric = isNumericKind(ATTRIBUTES.find((a) => a.id === attr)!.kind);
    overrides[attr] = value !== null && numeric ? String(Math.round(Number(value) * 10) / 10) : value;
  }

  updatePhoto(id, fields);
  setOverrides(id, overrides);
  sendAdminPhoto(res, id);
});

app.post("/api/admin/photos/:id/reclassify", (req, res) => {
  const id = param(req, "id");
  if (!getPhoto(id)) return res.status(404).json({ error: "Photo not found." });
  updatePhoto(id, { jev_status: "pending", jev_error: null });
  enqueue(id);
  sendAdminPhoto(res, id);
});

app.put("/api/admin/settings", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: Partial<SiteSettings> = {};
  if ("siteTitle" in body) {
    const title = typeof body.siteTitle === "string" ? body.siteTitle.trim() : "";
    if (!title || title.length > SITE_TITLE_MAX) return res.status(400).json({ error: `The site name must be 1–${SITE_TITLE_MAX} characters.` });
    patch.siteTitle = title;
  }
  if ("aboutText" in body) {
    if (typeof body.aboutText !== "string") return res.status(400).json({ error: "The About text must be text." });
    const about = body.aboutText.trim();
    if (about.length > ABOUT_TEXT_MAX) return res.status(400).json({ error: `The About text can be at most ${ABOUT_TEXT_MAX} characters.` });
    patch.aboutText = about; // empty clears it
  }
  res.json(saveSettings(patch));
});

// Re-tags every photo with the current questions; admin overrides are kept.
app.post("/api/admin/reclassify-all", (_req, res) => {
  const ids = markAllPending();
  enqueueAll(ids);
  res.json({ queued: ids.length });
});

// Possible duplicates among the visible photos (see duplicates.ts).
app.get("/api/admin/duplicates", (_req, res) => {
  res.json(duplicateReport());
});

// "Not duplicates": these photos are never grouped with each other again.
app.post("/api/admin/duplicates/dismiss", (req, res) => {
  const ids = (req.body as { ids?: unknown } | undefined)?.ids;
  if (!Array.isArray(ids) || ids.length < 2 || !ids.every((id) => typeof id === "string" && getPhoto(id))) {
    return res.status(400).json({ error: "Expected the ids of two or more photos." });
  }
  dismissPairs(ids);
  res.json(duplicateReport());
});

app.delete("/api/admin/photos/:id", async (req, res) => {
  const photo = getPhoto(param(req, "id"));
  if (!photo) return res.status(404).json({ error: "Photo not found." });
  deletePhoto(photo.id);
  await removePhotoFiles(photo.id, photo.original_ext);
  res.json({ ok: true });
});

// ---- Static (production) ----

if (process.env.NODE_ENV === "production") {
  const dist = path.join(root, "dist");
  app.use(express.static(dist));
  app.get(["/admin", "/admin/{*path}"], (_req, res) => res.sendFile(path.join(dist, "admin", "index.html")));
  app.get("/{*path}", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    const msg =
      err.code === "LIMIT_FILE_SIZE"
        ? `A photo is larger than ${MAX_UPLOAD_MB} MB.`
        : err.code === "LIMIT_FILE_COUNT"
          ? `Upload at most ${MAX_FILES_PER_UPLOAD} photos at a time.`
          : err.message;
    return res.status(413).json({ error: msg });
  }
  console.error(err);
  res.status(500).json({ error: "Unexpected server error." });
});

pruneAttributes(ATTRIBUTE_IDS, isValidAttributeValue); // clears tags left over from older question sets
resumePending();

app.listen(PORT, () => {
  console.log(
    `photo-ferret on http://localhost:${PORT} (model ${JEV_MODEL}, key ${hasApiKey() ? "set" : "MISSING"}, admin ${adminConfigured() ? "configured" : "NOT configured"})`,
  );
});
