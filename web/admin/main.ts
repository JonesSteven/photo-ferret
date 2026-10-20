import { ABOUT_TEXT_MAX, type AdminPhoto, type AttributeDef, type AttributeValue, type PhotoPatch, SITE_TITLE_MAX, type SiteSettings, type UploadResult } from "../../shared/types.ts";
import { $, api, el, formatBytes, HttpError, isNumeric, pct, placeBox, valueLabel } from "../shared/ui.ts";

const POLL_MS = 3000;
const UPLOAD_CONCURRENCY = 2;

const grid = $("grid");
const editor = $<HTMLDialogElement>("editor");

let defs: AttributeDef[] = [];
let photos: AdminPhoto[] = [];
let view: "all" | "pending" | "error" | "hidden" = "all";
let editing: AdminPhoto | null = null;
let pollTimer: number | undefined;
// Upload rows still waiting for Jev, by photo id; refresh() updates them when tagging finishes.
const taggingRows = new Map<string, HTMLLIElement>();
const deletedIds = new Set<string>(); // photos deleted in this session, so their upload rows can say so
let refreshSeq = 0;

function showError(msg: string | null) {
  $("error").textContent = msg ?? "";
  $("error").hidden = !msg;
}

// Any request that comes back 401 means the session expired: go back to the login form.
async function adminApi<T>(url: string, init?: Parameters<typeof api>[1]) {
  try {
    return await api<T>(url, init);
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) showLogin();
    throw err;
  }
}

// ---- Sign in ----

function showLogin() {
  $("login-view").hidden = false;
  $("app-view").hidden = true;
  $("logout").hidden = true;
  if (editor.open) editor.close();
  clearTimeout(pollTimer);
}

async function showApp() {
  $("login-view").hidden = true;
  $("app-view").hidden = false;
  $("logout").hidden = false;
  if (!defs.length) defs = await api<AttributeDef[]>("/api/attributes");
  void loadSettings();
  await refresh();
}

// ---- Gallery views (site settings) ----

const titleInput = $<HTMLInputElement>("set-title");
const aboutInput = $<HTMLTextAreaElement>("set-about");
aboutInput.maxLength = ABOUT_TEXT_MAX;
titleInput.maxLength = SITE_TITLE_MAX;
let savedTitle = "";
function showSiteTitle(title: string) {
  savedTitle = title;
  titleInput.value = title;
  document.title = `Admin · ${title}`;
  $("brand").textContent = title;
}
async function loadSettings() {
  const s = await api<SiteSettings>("/api/settings");
  showSiteTitle(s.siteTitle);
  aboutInput.value = s.aboutText;
}
async function saveSetting(patch: Partial<SiteSettings>) {
  const status = $("settings-status");
  try {
    const s = await adminApi<SiteSettings>("/api/admin/settings", { method: "PUT", json: patch });
    status.textContent = "Saved";
    setTimeout(() => (status.textContent = ""), 1500);
    return s;
  } catch (err) {
    status.textContent = `Couldn't save: ${(err as Error).message}`;
    return null;
  }
}
// The site name saves when the field is left or Enter is pressed; an empty name goes back to the saved one.
titleInput.addEventListener("change", async () => {
  const title = titleInput.value.trim();
  if (!title || title === savedTitle) return showSiteTitle(savedTitle);
  const s = await saveSetting({ siteTitle: title });
  showSiteTitle(s ? s.siteTitle : savedTitle);
});
// The About text saves when the field is left; it may be empty.
aboutInput.addEventListener("change", async () => {
  const s = await saveSetting({ aboutText: aboutInput.value });
  if (s) aboutInput.value = s.aboutText;
});

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target as HTMLFormElement);
  const err = $("login-error");
  err.hidden = true;
  try {
    await api("/api/admin/login", { method: "POST", json: { user: form.get("user"), password: form.get("password") } });
    (e.target as HTMLFormElement).reset();
    await showApp();
  } catch (error) {
    err.textContent = (error as Error).message;
    err.hidden = false;
  }
});

$("logout").addEventListener("click", async () => {
  await api("/api/admin/logout", { method: "POST" }).catch(() => {});
  showLogin();
});

// ---- Photo list ----

const statusOf = (p: AdminPhoto) => (p.jevStatus === "pending" ? "pending" : p.jevStatus === "error" ? "error" : !p.published ? "hidden" : "live");

function renderToolbar() {
  const counts = { all: photos.length, pending: 0, error: 0, hidden: 0 };
  for (const p of photos) {
    if (p.jevStatus === "pending") counts.pending++;
    if (p.jevStatus === "error") counts.error++;
    if (!p.published) counts.hidden++;
  }
  const labels = { all: "All", pending: "Tagging", error: "Errors", hidden: "Hidden" } as const;
  $("status-seg").replaceChildren(
    ...(Object.keys(labels) as (keyof typeof labels)[]).map((k) => {
      const b = el("button", { type: "button", role: "radio", "aria-checked": String(view === k), text: `${labels[k]} (${counts[k]})` });
      b.addEventListener("click", () => {
        view = k;
        render();
      });
      return b;
    }),
  );
}

function visiblePhotos() {
  if (view === "pending") return photos.filter((p) => p.jevStatus === "pending");
  if (view === "error") return photos.filter((p) => p.jevStatus === "error");
  if (view === "hidden") return photos.filter((p) => !p.published);
  return photos;
}

function tile(p: AdminPhoto) {
  const status = statusOf(p);
  const badge = { pending: "Tagging…", error: "Error", hidden: "Hidden", live: "" }[status];
  const primaryDef = defs.find((d) => d.group === "primary");
  const primary = primaryDef ? p.attrs[primaryDef.id] : undefined;
  const card = el(
    "button",
    { class: `tile admin-tile status-${status}`, type: "button", "aria-label": `Edit ${p.title ?? p.name}` },
    p.derivedReady ? el("img", { src: `${p.thumbUrl}?v=${encodeURIComponent(p.classifiedAt ?? p.createdAt)}`, alt: "", loading: "lazy" }) : el("span", { class: "tile-placeholder", text: p.jevStatus === "error" ? "No preview" : "Processing…" }),
    badge ? el("span", { class: `badge badge-${status}`, text: badge }) : null,
    el(
      "span",
      { class: "tile-caption" },
      el("strong", { text: p.title ?? p.name, title: `Uploaded as ${p.originalName}` }),
      primaryDef && primary ? el("span", { text: valueLabel(primaryDef, primary) }) : null,
    ),
  );
  card.addEventListener("click", () => openEditor(p));
  return card;
}

function render() {
  renderToolbar();
  const list = visiblePhotos();
  grid.replaceChildren(...list.map(tile));
  $("empty").hidden = photos.length > 0;
  $("count").textContent = `${list.length} shown`;
}

async function refresh() {
  const seq = ++refreshSeq;
  try {
    const list = await adminApi<AdminPhoto[]>("/api/admin/photos");
    // With many uploads, refreshes overlap; an older list can arrive last and would lack the newest photos.
    if (seq !== refreshSeq) return;
    photos = list;
    showError(null);
    render();
    updateUploadRows();
    if (editing) {
      const fresh = photos.find((p) => p.id === editing!.id);
      if (fresh && (fresh.jevStatus !== editing.jevStatus || fresh.classifiedAt !== editing.classifiedAt)) renderEditor(fresh, false);
    }
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 401)) showError(`Couldn't load photos: ${(err as Error).message}`);
    return;
  }
  clearTimeout(pollTimer);
  if (taggingRows.size || photos.some((p) => p.jevStatus === "pending")) pollTimer = window.setTimeout(refresh, POLL_MS);
}

function updateUploadRows() {
  for (const [id, row] of taggingRows) {
    const p = photos.find((x) => x.id === id);
    const state = row.querySelector<HTMLElement>(".up-state")!;
    if (!p) {
      if (!deletedIds.has(id)) continue; // not in this list yet; keep waiting
      state.textContent = "Deleted";
    } else if (p.jevStatus === "done") {
      state.textContent = "Uploaded and tagged";
      row.classList.add("tagged");
    } else if (p.jevStatus === "error") {
      state.textContent = `Uploaded, but tagging failed: ${p.jevError ?? "unknown error"}`;
      row.classList.add("failed");
    } else {
      continue; // still pending
    }
    taggingRows.delete(id);
  }
}

function replacePhoto(p: AdminPhoto) {
  const i = photos.findIndex((x) => x.id === p.id);
  if (i >= 0) photos[i] = p;
  else photos.unshift(p);
  render();
}

// ---- Upload ----

function uploadOne(file: File, row: HTMLLIElement) {
  const bar = row.querySelector<HTMLElement>(".fill")!;
  const state = row.querySelector<HTMLElement>(".up-state")!;
  return new Promise<void>((resolve) => {
    const body = new FormData();
    body.append("photos", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/admin/photos");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) bar.style.width = pct(e.loaded / e.total);
    };
    xhr.onload = () => {
      let results: UploadResult[] | { error: string };
      try {
        results = JSON.parse(xhr.responseText);
      } catch {
        results = { error: `Server returned ${xhr.status}` };
      }
      if (xhr.status === 401) showLogin();
      const r = Array.isArray(results) ? results[0] : { name: file.name, error: results.error };
      if (r?.photo) {
        row.classList.add("ok");
        state.textContent = "Uploaded · tagging…";
        taggingRows.set(r.photo.id, row);
        replacePhoto(r.photo);
        void refresh();
      } else {
        row.classList.add("failed");
        state.textContent = r?.error ?? "Upload failed";
      }
      resolve();
    };
    xhr.onerror = () => {
      row.classList.add("failed");
      state.textContent = "Network error";
      resolve();
    };
    xhr.send(body);
  });
}

async function uploadFiles(files: File[]) {
  if (!files.length) return;
  const list = $("uploads");
  const jobs = files.map((file) => {
    const row = el(
      "li",
      { class: "upload" },
      el("span", { class: "up-name", text: file.name }),
      el("span", { class: "up-size muted", text: formatBytes(file.size) }),
      el("span", { class: "track" }, el("span", { class: "fill" })),
      el("span", { class: "up-state muted", text: "Waiting" }),
    );
    list.prepend(row);
    return { file, row };
  });
  const next = async (): Promise<void> => {
    const job = jobs.shift();
    if (!job) return;
    job.row.querySelector<HTMLElement>(".up-state")!.textContent = "Uploading";
    await uploadOne(job.file, job.row);
    return next();
  };
  await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, next));
}

const drop = $<HTMLLabelElement>("drop");
const fileInput = $<HTMLInputElement>("file");
fileInput.addEventListener("change", () => {
  void uploadFiles([...(fileInput.files ?? [])]);
  fileInput.value = "";
});
drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") (e.preventDefault(), fileInput.click());
});
for (const t of ["dragenter", "dragover"]) drop.addEventListener(t, (e) => (e.preventDefault(), drop.classList.add("over")));
for (const t of ["dragleave", "drop"]) drop.addEventListener(t, (e) => (e.preventDefault(), drop.classList.remove("over")));
drop.addEventListener("drop", (e) => void uploadFiles([...((e as DragEvent).dataTransfer?.files ?? [])]));

// ---- Editor ----

function flashSaved(msg = "Saved") {
  const s = $("ed-saved");
  s.textContent = msg;
  window.setTimeout(() => s.textContent === msg && (s.textContent = ""), 1800);
}

async function patch(body: PhotoPatch) {
  if (!editing) return;
  try {
    const p = await adminApi<AdminPhoto>(`/api/admin/photos/${editing.id}`, { method: "PATCH", json: body });
    replacePhoto(p);
    renderEditor(p, false);
    flashSaved();
  } catch (err) {
    flashSaved(`Couldn't save: ${(err as Error).message}`);
  }
}

// Yes/no answers show Jev's probability of yes, not a "confidence": P(yes) 2% is a strong No.
function yesNoSummary(a: AttributeValue) {
  const p = a.detail?.p;
  if (p == null) return `Jev: ${a.jevValue === "true" ? "Yes" : a.jevValue === "false" ? "No" : "Unsure"}`;
  const final = a.detail?.closeLookP ?? p;
  const lean = final >= 0.5 ? "Yes" : "No";
  const strength = Math.abs(2 * final - 1) >= 0.8 ? "strong" : Math.abs(2 * final - 1) >= 0.4 ? "likely" : "leaning";
  const verdict = a.jevValue === "uncertain" ? `Unsure (${strength === "leaning" ? "leaning" : strength} ${lean})` : `${strength} ${lean}`;
  const closer = a.detail?.closeLookP != null ? ` → ${pct(a.detail.closeLookP)} on a closer look` : "";
  return `Jev: P(yes) ${pct(p)}${closer} · ${verdict}`;
}

function jevSummary(def: AttributeDef, a: AttributeValue) {
  const who = def.source === "computed" ? "Measured" : "Jev";
  if (a.jevValue == null) return def.source === "jev" && a.override == null ? "Not tagged, or doesn't apply" : "—";
  if (def.kind === "boolean") return yesNoSummary(a);
  const conf = a.jevConfidence == null ? "" : ` · ${pct(a.jevConfidence)} sure`;
  const raw = def.kind === "scale" ? ` (${Math.round(Number(a.jevValue))})` : "";
  const present = def.kind === "percent" && a.detail?.pPresent != null ? ` · P(present) ${pct(a.detail.pPresent)}` : "";
  return `${who}: ${valueLabel(def, a.jevValue)}${raw}${present}${conf}`;
}

// Numeric override: a 0–100 number box plus a button back to Jev's value.
function numericControl(def: AttributeDef, a: AttributeValue) {
  const min = def.id === "quality" ? 1 : 0; // quality runs 1–100 (server/jev.ts qualityValue)
  const input = el("input", {
    type: "number",
    min: String(min),
    max: "100",
    step: "1",
    class: "num-input",
    "aria-label": `${def.label} override (${min}–100)`,
    placeholder: a.jevValue == null ? "" : String(Math.round(Number(a.jevValue))),
  });
  if (a.override != null) input.value = String(Math.round(Number(a.override)));
  input.addEventListener("change", () => {
    const v = input.value.trim();
    if (v === "") return void patch({ overrides: { [def.id]: null } });
    const n = Math.max(min, Math.min(100, Number(v)));
    if (Number.isFinite(n)) void patch({ overrides: { [def.id]: String(n) } });
  });
  const reset = el("button", { type: "button", class: "link-btn small", text: "Use Jev", hidden: a.override == null });
  reset.addEventListener("click", () => void patch({ overrides: { [def.id]: null } }));
  return el("span", { class: "num-control" }, input, el("span", { class: "muted small", text: def.kind === "percent" ? "%" : "/100" }), reset);
}

function attrRow(def: AttributeDef, a: AttributeValue, p: AdminPhoto) {
  const overridden = a.override != null;
  let control: HTMLElement;
  if (def.kind === "multi") {
    control = el("span", { class: "muted small", text: "Measured from the pixels" });
  } else if (isNumeric(def)) {
    control = numericControl(def, a);
  } else if (def.kind === "boolean") {
    const options: [string | null, string][] = [
      [null, "Jev"],
      ["true", "Yes"],
      ["false", "No"],
    ];
    control = el(
      "div",
      { class: "seg seg-small", role: "radiogroup", "aria-label": def.label },
      ...options.map(([v, label]) => {
        const b = el("button", { type: "button", role: "radio", "aria-checked": String(a.override === v), text: label });
        b.addEventListener("click", () => void patch({ overrides: { [def.id]: v } }));
        return b;
      }),
    );
  } else {
    const select = el(
      "select",
      { "aria-label": def.label },
      el("option", { value: "", text: `Jev (${valueLabel(def, a.jevValue)})` }),
      ...(def.options ?? []).map((o) => el("option", { value: o.id, selected: a.override === o.id, text: o.label })),
    );
    select.addEventListener("change", () => void patch({ overrides: { [def.id]: select.value || null } }));
    control = select;
  }

  const pYes = a.detail?.closeLookP ?? a.detail?.p;
  const meterWidth = isNumeric(def) && a.value != null ? `${Math.min(100, Number(a.value))}%` : def.kind === "boolean" && pYes != null ? pct(pYes) : null;
  const present = def.kind === "percent" ? p.contains.includes(def.id) : isNumeric(def) || a.value === "true" || def.kind === "choice" || def.kind === "multi";
  const meter = meterWidth ? el("span", { class: "track" }, el("span", { class: `fill${present ? " on" : ""}`, style: `width:${meterWidth}` })) : null;
  // Split answers (e.g. Jev torn between None and About half) are worth a look.
  const unsure = a.override == null && (a.jevValue === "uncertain" || Boolean(a.detail?.uncertain));

  return el(
    "div",
    { class: `attr-row${overridden ? " overridden" : ""}${present && a.value != null ? " on" : ""}${unsure ? " unsure" : ""}` },
    el(
      "span",
      { class: "attr-name" },
      def.label,
      overridden ? el("span", { class: "edited", text: "edited" }) : null,
      unsure ? el("span", { class: "unsure-flag", title: "Jev was unsure; check and override if needed", text: "unsure" }) : null,
    ),
    el("span", { class: "attr-jev" }, el("span", { class: "muted small", text: jevSummary(def, a) }), meter),
    control,
  );
}

function renderEditor(p: AdminPhoto, fresh: boolean) {
  editing = p;
  const img = $<HTMLImageElement>("ed-img");
  const src = p.derivedReady ? `${p.jevUrl}?v=${encodeURIComponent(p.classifiedAt ?? p.createdAt)}` : "";
  if (img.getAttribute("src") !== src) img.src = src;
  img.hidden = !p.derivedReady;

  // Boxes are kept only for tags Jev answered "yes"; an override to No hides them too.
  const frame = $("ed-img").parentElement!;
  for (const old of frame.querySelectorAll(".box")) old.remove();
  for (const b of p.boxes) {
    if (p.attrs[b.id] !== "true") continue;
    const boxEl = el("div", { class: `box box-${b.id}` });
    frame.insertBefore(boxEl, $("ed-busy")); // under the busy overlay
    placeBox(boxEl, b.box, b.confidence == null ? b.label : `${b.label} · ${pct(b.confidence)}`);
  }

  $("ed-busy").hidden = p.jevStatus !== "pending";
  $("ed-busy-text").textContent = p.derivedReady ? "Asking Jev…" : "Processing…";

  const dims = p.width && p.height ? ` · ${p.width}×${p.height}` : "";
  // The uploaded file name is only shown here, in the admin; visitors see p.name / p.fileName.
  $("ed-file").textContent = `${p.fileName} · uploaded as ${p.originalName} · ${formatBytes(p.bytes)}${dims}`;
  const a = $<HTMLAnchorElement>("ed-download");
  a.href = p.originalUrl;
  a.setAttribute("download", p.fileName);
  $<HTMLButtonElement>("ed-rerun").disabled = p.jevStatus === "pending" || !p.derivedReady;

  const status = $("ed-status");
  status.className = `ed-status status-${statusOf(p)}`;
  status.textContent =
    p.jevStatus === "pending"
      ? "Jev is tagging this photo…"
      : p.jevStatus === "error"
        ? p.jevError ?? "Something went wrong."
        : `Tagged by ${p.jevModel ?? "Jev"}${p.classifiedAt ? ` on ${new Date(p.classifiedAt).toLocaleString()}` : ""}${p.tiles ? ` · panorama, analysed in ${p.tiles} tiles` : ""}`;

  if (fresh) {
    $<HTMLInputElement>("ed-title").value = p.title ?? "";
    $<HTMLTextAreaElement>("ed-desc").value = p.description ?? "";
    $("ed-saved").textContent = "";
  }
  $<HTMLInputElement>("ed-published").checked = p.published;

  const byId = new Map(p.attributes.map((x) => [x.attr, x]));
  const groups: [string, AttributeDef["group"][]][] = [
    ["Primary subject & what's in it", ["primary", "presence"]],
    ["Activities (only when a person is in the photo)", ["activity"]],
    ["Weather & sky", ["sky"]],
    ["Landscape · approximate % of frame", ["surface"]],
    ["Mood · 0–100", ["mood"]],
    ["Colour", ["colour"]],
    ["Look & composition · 0–100", ["look"]],
  ];
  $("ed-attrs").replaceChildren(
    ...groups.flatMap(([title, gs]) => [
      el("h3", { class: "attr-group", text: title }),
      ...defs.filter((d) => gs.includes(d.group)).map((d) => attrRow(d, byId.get(d.id)!, p)),
    ]),
  );
}

function openEditor(p: AdminPhoto) {
  renderEditor(p, true);
  if (!editor.open) editor.showModal();
}

$("ed-close").addEventListener("click", () => editor.close());
editor.addEventListener("click", (e) => {
  if (e.target === editor) editor.close();
});
editor.addEventListener("close", () => (editing = null));

for (const [id, key] of [
  ["ed-title", "title"],
  ["ed-desc", "description"],
] as const) {
  const input = $<HTMLInputElement | HTMLTextAreaElement>(id);
  input.addEventListener("change", () => {
    if (editing && (editing[key] ?? "") !== input.value.trim()) void patch({ [key]: input.value });
  });
}
$<HTMLInputElement>("ed-published").addEventListener("change", (e) => void patch({ published: (e.target as HTMLInputElement).checked }));

$("ed-rerun").addEventListener("click", async () => {
  if (!editing) return;
  const p = await adminApi<AdminPhoto>(`/api/admin/photos/${editing.id}/reclassify`, { method: "POST" });
  replacePhoto(p);
  renderEditor(p, false);
  void refresh();
});

$("ed-delete").addEventListener("click", async () => {
  if (!editing) return;
  if (!confirm(`Delete "${editing.title ?? editing.name}" (${editing.originalName})? This removes the original file too and can't be undone.`)) return;
  const id = editing.id;
  try {
    await adminApi(`/api/admin/photos/${id}`, { method: "DELETE" });
    photos = photos.filter((p) => p.id !== id);
    deletedIds.add(id);
    editor.close();
    render();
  } catch (err) {
    flashSaved(`Couldn't delete: ${(err as Error).message}`);
  }
});

$("retag-all").addEventListener("click", async () => {
  if (!confirm("Re-tag every photo with the current Jev questions? This sends one Jev request per photo. Your manual overrides are kept.")) return;
  try {
    const r = await adminApi<{ queued: number }>("/api/admin/reclassify-all", { method: "POST" });
    showError(null);
    $("count").textContent = `Re-tagging ${r.queued} photo(s)…`;
    await refresh();
  } catch (err) {
    showError(`Couldn't start re-tagging: ${(err as Error).message}`);
  }
});

// ---- Start ----

// The site name is public, so the header and tab show it on the sign-in screen too.
void api<SiteSettings>("/api/settings").then((s) => showSiteTitle(s.siteTitle), () => {});
const me = await api<{ admin: boolean; configured: boolean; apiKeyConfigured: boolean; model: string }>("/api/admin/me");
$("jev-status").textContent = me.apiKeyConfigured ? me.model : "Jev key missing";
$("jev-status").classList.toggle("warn", !me.apiKeyConfigured);
if (!me.configured) {
  showLogin();
  $("login-error").textContent = "Admin login isn't configured. Set ADMIN_USER and ADMIN_PASSWORD in .env and restart the server.";
  $("login-error").hidden = false;
} else if (me.admin) {
  await showApp();
} else {
  showLogin();
}
