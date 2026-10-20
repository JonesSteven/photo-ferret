import { createGallery } from "../shared/gallery.ts";
import { type AttributeDef, type ColourPoint, DEFAULT_SETTINGS, type MapPoint, type PhotoListResponse, type PublicPhoto, type SiteData, type SiteSettings } from "../shared/types.ts";
import { $, api, coverWord, el, isNumeric, levelLabel, placeBox, shiftWindow, valueLabel } from "./shared/ui.ts";

// Public gallery. Everything lives in the URL query so a view can be shared as a link:
//   numeric attributes as ranges (?cover_forest=70-100&wildness=40-70) or "present" (?cover_snow=present),
//   others as values (?person=false, ?palette=blue),
//   plus view=sliders|map, sort=<attr>, and in map view the pointers m1/m2=x,y,radius.
//   The filtering (shared/gallery.ts) ignores the keys it doesn't know.

// While a slider is dragged the gallery reloads at most this often, and the address bar is written at
// most every URL_WRITE_MS: Safari refuses more than ~100 history updates per 10 seconds.
const LIVE_RELOAD_MS = 200;
const URL_WRITE_MS = 400;

const grid = $("grid");
const errorBox = $("error");
const empty = $("empty");
const lightbox = $<HTMLDialogElement>("lightbox");

let defs: AttributeDef[] = [];
let photos: PublicPhoto[] = [];
let current = -1; // index into photos shown in the lightbox
let shown: PublicPhoto | null = null; // the photo in the lightbox
let reloadTimer: number | undefined;
let urlTimer: number | undefined;

// Controls are built once and updated in place after each load, so a slider being dragged keeps its grip.
const updaters: ((data: PhotoListResponse, q: URLSearchParams) => void)[] = [];

// The current view. The address bar mirrors it (lagging slightly during a drag) so it can be shared.
let query = new URLSearchParams(location.search);
const params = () => new URLSearchParams(query);
let settings: SiteSettings = { ...DEFAULT_SETTINGS };

function writeUrl(push: boolean) {
  clearTimeout(urlTimer);
  urlTimer = undefined;
  const qs = query.toString();
  if (location.search === (qs ? `?${qs}` : "")) return;
  try {
    if (push) history.pushState(null, "", qs ? `?${qs}` : location.pathname);
    else history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
  } catch {
    // Safari's rate limit; the view itself is unaffected and the next write catches the address bar up.
  }
}

// live: a slider is moving. Reloads and address-bar writes are throttled, not postponed until the
// movement stops, so the gallery keeps up during a slow drag. Otherwise both happen at once.
function navigate(change: (q: URLSearchParams) => void, opts: { replace?: boolean; live?: boolean } = {}) {
  const q = params();
  change(q);
  const changed = q.toString() !== query.toString();
  query = q;
  if (opts.live) {
    if (!changed) return;
    urlTimer ??= window.setTimeout(() => writeUrl(false), URL_WRITE_MS);
    reloadTimer ??= window.setTimeout(() => {
      reloadTimer = undefined;
      void load();
    }, LIVE_RELOAD_MS);
    return;
  }
  writeUrl(!opts.replace);
  clearTimeout(reloadTimer);
  reloadTimer = undefined;
  void load();
}

const setParam = (key: string, value: string | null) => (q: URLSearchParams) => (value == null ? q.delete(key) : q.set(key, value));

function parseRange(v: string | null): [number, number] {
  const m = v ? /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2])] : [0, 100];
}

function showError(msg: string | null) {
  errorBox.textContent = msg ?? "";
  errorBox.hidden = !msg;
}

// ---- Controls ----

const newSeed = () => String(Math.floor(Math.random() * 1e9));
const pageSeed = newSeed(); // the Random order for this visit, until a seed is chosen
const SORT_VALUE_KEY = "sort-show-value";
let showSortValue = true;
try {
  showSortValue = localStorage.getItem(SORT_VALUE_KEY) !== "0";
} catch {
  // storage unavailable
}

function buildSort() {
  const select = $<HTMLSelectElement>("sort-select");
  select.replaceChildren(
    el("option", { value: "", text: "Random" }),
    el("option", { value: "newest", text: "Newest first" }),
    el("option", { value: "number", text: "Image number" }),
    ...defs.filter(isNumeric).map((d) => el("option", { value: d.id, text: d.kind === "scale" ? `${d.label}: ${d.ends?.[1]} first` : `Most ${d.label.toLowerCase()}` })),
  );
  // Random (the default, no sort param) gets a fresh seed each time it's chosen; the seed keeps the order
  // steady while filtering. Without a seed in the address, the page's own seed is used (see load).
  select.addEventListener("change", () =>
    navigate((q) => {
      setParam("sort", select.value || null)(q);
      setParam("seed", select.value ? null : newSeed())(q);
    }),
  );
  updaters.push((_d, q) => (select.value = q.get("sort") === "random" ? "" : (q.get("sort") ?? "")));
  // "Display value": the sorted-by value on each thumbnail; remembered per browser.
  const toggle = checkToggle("Display value", showSortValue, (on) => {
    showSortValue = on;
    try {
      localStorage.setItem(SORT_VALUE_KEY, on ? "1" : "0");
    } catch {
      // storage unavailable; the choice just isn't remembered
    }
    renderGrid();
  });
  toggle.title = "Show the sorted-by value on each photo";
  select.after(toggle);
}

function rangeText(d: AttributeDef, lo: number, hi: number) {
  if (lo <= 0 && hi >= 100) return "Any";
  if (d.kind === "percent") return hi >= 100 ? `≥ ${lo}%` : lo <= 0 ? `≤ ${hi}%` : `${lo}–${hi}%`;
  const a = levelLabel(d, lo);
  const b = levelLabel(d, hi);
  return a === b ? a : `${a} – ${b}`;
}

// Sliders view: a two-handle range over 0–100, with a density strip above it: brightness shows how many
// matching photos sit at each part of the range, and the parts outside the range are dimmed.
function buildSlider(d: AttributeDef) {
  const lo = el("input", { type: "range", min: "0", max: "100", step: "1", "aria-label": `${d.label} minimum` });
  const hi = el("input", { type: "range", min: "0", max: "100", step: "1", "aria-label": `${d.label} maximum` });
  const value = el("span", { class: "slider-value" });
  const clear = el("button", { type: "button", class: "slider-clear", title: `Reset ${d.label}`, "aria-label": `Reset ${d.label}`, text: "×" });
  clear.addEventListener("click", () => navigate(setParam(d.id, null), { replace: true }));
  const density = el("span", { class: "density-fill" });
  const dimLo = el("span", { class: "density-dim lo" });
  const dimHi = el("span", { class: "density-dim hi" });
  const fill = el("span", { class: "range-fill" });
  const card = el(
    "div",
    { class: "slider-card" },
    el("div", { class: "slider-head" }, el("span", { class: "slider-name", text: d.label }), el("span", { class: "slider-head-right" }, value, clear)),
    el("div", { class: "density", "aria-hidden": "true" }, density, dimLo, dimHi),
    el("div", { class: "range" }, el("span", { class: "range-track" }), fill, lo, hi),
    // Scales name their ends (Macro … Vista); coverage sliders don't need 0% / 100% spelled out.
    d.kind === "scale" && d.ends ? el("div", { class: "slider-ends" }, el("span", { text: d.ends[0] }), el("span", { text: d.ends[1] })) : null,
  );

  const paint = () => {
    const a = Number(lo.value);
    const b = Number(hi.value);
    fill.classList.toggle("movable", a > 0 || b < 100);
    value.textContent = rangeText(d, a, b);
    value.classList.toggle("active", a > 0 || b < 100);
    clear.hidden = a <= 0 && b >= 100;
    dimLo.style.width = `${a}%`;
    dimHi.style.width = `${100 - b}%`;
    fill.style.left = `${a}%`;
    fill.style.right = `${100 - b}%`;
  };
  // Applies the handles' range. While dragging, reloads are throttled; on release (commit) the gallery
  // reloads at once, so the final position never depends on a pending timer.
  const apply = (commit = false) => {
    const a = Number(lo.value);
    const b = Number(hi.value);
    navigate(setParam(d.id, a <= 0 && b >= 100 ? null : `${a}-${b}`), { replace: true, live: !commit });
  };
  const onInput = (moved: HTMLInputElement) => {
    if (Number(lo.value) > Number(hi.value)) (moved === lo ? hi : lo).value = moved.value; // handles push each other
    paint();
    apply();
  };
  // A handle being held is never set from code: some browsers stop reporting a native slider drag
  // when its value is changed underneath it.
  let held = false;
  for (const input of [lo, hi]) {
    input.addEventListener("input", () => onInput(input));
    input.addEventListener("pointerdown", () => (held = true));
    input.addEventListener("change", () => {
      held = false;
      apply(true);
    });
  }
  const release = () => {
    if (!held) return;
    held = false;
    apply(true);
  };
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);

  // Grab the shaded window between the handles and slide it; its width stays the same.
  const moveWindow = (a: number, b: number, delta: number) => {
    const [na, nb] = shiftWindow(a, b, delta);
    lo.value = String(na);
    hi.value = String(nb);
    paint();
    apply();
  };
  fill.tabIndex = 0;
  fill.setAttribute("role", "slider");
  fill.setAttribute("aria-label", `${d.label} range — drag or use arrow keys to move it`);
  let drag: { x: number; a: number; b: number } | null = null;
  fill.addEventListener("pointerdown", (e) => {
    const a = Number(lo.value);
    const b = Number(hi.value);
    if (a <= 0 && b >= 100) return; // nothing to move
    e.preventDefault();
    fill.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, a, b };
    fill.classList.add("dragging");
  });
  fill.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const width = (fill.parentElement as HTMLElement).getBoundingClientRect().width || 1;
    moveWindow(drag.a, drag.b, Math.round(((e.clientX - drag.x) / width) * 100));
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    fill.classList.remove("dragging");
    apply(true);
  };
  fill.addEventListener("pointerup", endDrag);
  fill.addEventListener("pointercancel", endDrag);
  fill.addEventListener("lostpointercapture", endDrag); // e.g. the window lost focus mid-drag
  fill.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const step = (e.shiftKey ? 10 : 1) * (e.key === "ArrowLeft" ? -1 : 1);
    moveWindow(Number(lo.value), Number(hi.value), step);
  });

  updaters.push((data, q) => {
    // Follow the URL (Clear filters, Back, chips), except while this slider is being dragged.
    const [a, b] = parseRange(q.get(d.id));
    if (!drag && !held) {
      lo.value = String(a);
      hi.value = String(b);
    }
    const hist = data.histograms[d.id] ?? [];
    const max = Math.max(1, ...hist);
    // Brightness ∝ √count, so a bin with a few photos still shows against an empty one; stops sit at bin centres.
    const stops = hist.map((n, i) => `color-mix(in srgb, var(--density-on) ${Math.round(Math.sqrt(n / max) * 100)}%, var(--density-off)) ${i * 10 + 5}%`);
    density.style.background = stops.length ? `linear-gradient(to right, ${stops.join(", ")})` : "";
    density.parentElement!.title = hist.map((n, i) => `${i * 10}–${i * 10 + 10}: ${n}`).join("\n");
    paint();
  });
  return card;
}

function buildSliders() {
  for (const group of ["surface", "mood", "colour", "look"] as const) {
    // Numeric tags only: the colour group also holds the palette, which has chips instead. Saturation has
    // no slider of its own: the colour picker's box sets it (the same saturation param).
    const sliders = defs.filter((d) => d.group === group && isNumeric(d) && d.id !== "saturation").map(buildSlider);
    $(`sliders-${group}`).replaceChildren(...sliders);
    $(`sliders-${group}`).closest<HTMLElement>(".slider-section")!.hidden = !sliders.length;
  }
  $("sliders-colour").prepend(buildColourPicker());
}

// Colour picker: a square with the colour axis across (neutral band, then red → … → pink, by each photo's
// main colour) and saturation up. Drag out a box to filter on both: hue=a-b (colour axis) and
// saturation=c-d (the saturation tag's own range param).
type ColourBox = { x1: number; x2: number; y1: number; y2: number };
const FULL_BOX: ColourBox = { x1: 0, x2: 100, y1: 0, y2: 100 };
const isFull = (b: ColourBox) => b.x1 <= 0 && b.x2 >= 100 && b.y1 <= 0 && b.y2 >= 100;
const COLOUR_TICKS: [number, string][] = [[5, "N"], [16, "R"], [24, "O"], [31, "Y"], [44, "G"], [58, "T"], [70, "B"], [86, "P"], [96, "Pk"]];

function buildColourPicker() {
  const saturation = defs.find((d) => d.id === "saturation");
  const readBox = (q: URLSearchParams): ColourBox => {
    const [x1, x2] = parseRange(q.get("hue"));
    const [y1, y2] = parseRange(q.get("saturation"));
    return { x1, x2, y1, y2 };
  };
  let box = readBox(params());
  let points: ColourPoint[] = [];
  let drag: { mode: "new" | "move" | "resize"; from: { x: number; y: number }; start: ColourBox; edges: { l: boolean; r: boolean; b: boolean; t: boolean } } | null = null;

  const plot = svg("svg", { viewBox: `${-MAP_PAD} ${-MAP_PAD} ${100 + 2 * MAP_PAD} ${100 + 2 * MAP_PAD}`, class: "map-plot colour-plot", role: "img", "aria-label": "Colour and saturation" });
  // Hue across, fading to grey toward the bottom like a paint program's colour square.
  const defsEl = svg("defs", {});
  const hues = svg("linearGradient", { id: "cp-hue" });
  hues.append(svg("stop", { offset: "0", "stop-color": "#9a9a96" }), svg("stop", { offset: "0.1", "stop-color": "#9a9a96" }));
  for (let k = 0; k <= 12; k++) hues.append(svg("stop", { offset: String((12 + (k * 88) / 12) / 100), "stop-color": `hsl(${k * 30 - 15} 70% 55%)` }));
  const fade = svg("linearGradient", { id: "cp-fade", x1: "0", y1: "1", x2: "0", y2: "0" });
  fade.append(svg("stop", { offset: "0", "stop-color": "#9a9a96", "stop-opacity": "0.95" }), svg("stop", { offset: "1", "stop-color": "#9a9a96", "stop-opacity": "0" }));
  defsEl.append(hues, fade);
  const area = svg("g", { class: "colour-area" });
  area.append(
    svg("rect", { x: 0, y: 0, width: 100, height: 100, fill: "url(#cp-hue)" }),
    svg("rect", { x: 0, y: 0, width: 100, height: 100, fill: "url(#cp-fade)" }),
    svg("rect", { x: 0, y: 0, width: 100, height: 100, class: "colour-veil" }),
  );
  const dots = svg("g", { class: "map-dots colour-dots" });
  const boxEl = svg("rect", { class: "colour-box" });
  const handles = svg("g", { class: "colour-handles" });
  plot.append(defsEl, area, dots, boxEl, handles);

  const tipImg = el("img", { alt: "" });
  const tipText = el("span");
  const tip = el("div", { class: "map-tip", hidden: true }, tipImg, tipText);
  const value = el("span", { class: "slider-value" });
  const clear = el("button", { type: "button", class: "slider-clear", title: "Reset colour", "aria-label": "Reset colour", text: "×" });
  clear.addEventListener("click", () => navigate((q) => (q.delete("hue"), q.delete("saturation")), { replace: true }));
  const xAxis = el("div", { class: "map-x" }, ...COLOUR_TICKS.map(([x, label]) => el("span", { style: `left:${padPct(x)}%`, text: label })));
  const yAxis = el(
    "div",
    { class: "map-y" },
    el("span", { class: "end-low", style: `bottom:${padPct(0)}%`, text: "Muted" }),
    el("span", { class: "end-high", style: `bottom:${padPct(100)}%`, text: "Vivid" }),
  );
  const card = el(
    "div",
    { class: "slider-card colour-picker" },
    // The range text has its own line, so a long one can't wrap the header and shift the plot mid-drag.
    el("div", { class: "slider-head" }, el("span", { class: "slider-name", text: "Colour · Saturation" }), clear),
    el("div", { class: "colour-value" }, value),
    el("div", { class: "map-body" }, yAxis, el("div", { class: "map-plot-wrap" }, plot, tip)),
    xAxis,
    el("p", { class: "filter-note", text: "Drag to draw a box; drag it to move it or its edges to resize it. Hover a dot to see the photo." }),
  );

  const draw = () => {
    const full = isFull(box);
    boxEl.setAttribute("visibility", full ? "hidden" : "visible");
    boxEl.setAttribute("x", String(box.x1));
    boxEl.setAttribute("y", String(100 - box.y2));
    boxEl.setAttribute("width", String(box.x2 - box.x1));
    boxEl.setAttribute("height", String(box.y2 - box.y1));
    handles.replaceChildren(
      ...(full ? [] : [[box.x1, box.y1], [box.x2, box.y1], [box.x1, box.y2], [box.x2, box.y2]]).map(([x, y]) => svg("rect", { x: x! - 1.4, y: 100 - y! - 1.4, width: 2.8, height: 2.8 })),
    );
    clear.hidden = full;
    value.classList.toggle("active", !full);
    if (full) value.textContent = "Any";
    else {
      const hue = box.x1 <= 0 && box.x2 >= 100 ? "Any colour" : `${colourAt(box.x1).name}${colourAt(box.x1).name === colourAt(box.x2).name ? "" : ` – ${colourAt(box.x2).name}`}`;
      const sat = saturation ? rangeText(saturation, Math.round(box.y1), Math.round(box.y2)) : "";
      value.textContent = sat === "Any" ? hue : `${hue} · ${sat}`;
    }
  };
  const drawDots = () => {
    const active = !isFull(box); // without a box every photo matches; only highlight inside a box
    const ordered = [...points].sort((p, q) => Number(p.match) - Number(q.match));
    dots.replaceChildren(...ordered.map((p) => svg("circle", { cx: p.x, cy: 100 - p.y, r: active && p.match ? 1.9 : 1.4, class: active && p.match ? "match" : "" })));
  };

  const range = (a: number, b: number) => (a <= 0 && b >= 100 ? null : `${Math.round(a)}-${Math.round(b)}`);
  const apply = (commit = false) =>
    navigate(
      (q) => {
        setParam("hue", range(box.x1, box.x2))(q);
        setParam("saturation", range(box.y1, box.y2))(q);
      },
      { replace: true, live: !commit },
    );

  const at = (e: PointerEvent) => {
    const r = plot.getBoundingClientRect();
    const clamp = (n: number) => Math.max(0, Math.min(100, n));
    const span = 100 + 2 * MAP_PAD;
    return { x: clamp(((e.clientX - r.left) / r.width) * span - MAP_PAD), y: clamp(100 - (((e.clientY - r.top) / r.height) * span - MAP_PAD)) };
  };
  const GRAB = 3; // plot units around an edge that grab it
  const edgesAt = (p: { x: number; y: number }) => {
    const inX = p.x >= box.x1 - GRAB && p.x <= box.x2 + GRAB;
    const inY = p.y >= box.y1 - GRAB && p.y <= box.y2 + GRAB;
    return {
      l: inY && Math.abs(p.x - box.x1) <= GRAB,
      r: inY && Math.abs(p.x - box.x2) <= GRAB,
      b: inX && Math.abs(p.y - box.y1) <= GRAB,
      t: inX && Math.abs(p.y - box.y2) <= GRAB,
    };
  };
  const cursorFor = (p: { x: number; y: number }) => {
    if (isFull(box)) return "crosshair";
    const e = edgesAt(p);
    if ((e.l && e.t) || (e.r && e.b)) return "nwse-resize";
    if ((e.r && e.t) || (e.l && e.b)) return "nesw-resize";
    if (e.l || e.r) return "ew-resize";
    if (e.t || e.b) return "ns-resize";
    return p.x > box.x1 && p.x < box.x2 && p.y > box.y1 && p.y < box.y2 ? "move" : "crosshair";
  };
  const hover = (e: PointerEvent) => {
    const p = at(e);
    plot.style.cursor = cursorFor(p);
    let best: ColourPoint | null = null;
    let bestD = 3;
    for (const d of points) {
      const dist = Math.hypot(d.x - p.x, d.y - p.y);
      if (dist < bestD) [best, bestD] = [d, dist];
    }
    tip.hidden = !best;
    if (!best) return;
    tipImg.src = best.thumbUrl;
    tipText.textContent = best.title;
    tip.style.left = `${padPct(best.x)}%`;
    tip.style.top = `${padPct(100 - best.y)}%`;
    tip.classList.toggle("left", best.x > 55);
    tip.classList.toggle("below", best.y > 60);
  };

  plot.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    plot.setPointerCapture(e.pointerId);
    tip.hidden = true;
    const p = at(e);
    const edges = isFull(box) ? { l: false, r: false, b: false, t: false } : edgesAt(p);
    const inside = !isFull(box) && p.x > box.x1 && p.x < box.x2 && p.y > box.y1 && p.y < box.y2;
    const mode = edges.l || edges.r || edges.b || edges.t ? "resize" : inside ? "move" : "new";
    drag = { mode, from: p, start: { ...box }, edges };
  });
  const dragTo = (e: PointerEvent) => {
    if (!drag) return;
    const p = at(e);
    const s = drag.start;
    if (drag.mode === "new") {
      box = { x1: Math.min(drag.from.x, p.x), x2: Math.max(drag.from.x, p.x), y1: Math.min(drag.from.y, p.y), y2: Math.max(drag.from.y, p.y) };
    } else if (drag.mode === "move") {
      const dx = Math.max(-s.x1, Math.min(100 - s.x2, p.x - drag.from.x));
      const dy = Math.max(-s.y1, Math.min(100 - s.y2, p.y - drag.from.y));
      box = { x1: s.x1 + dx, x2: s.x2 + dx, y1: s.y1 + dy, y2: s.y2 + dy };
    } else {
      const { l, r, b, t } = drag.edges;
      const x1 = l ? Math.min(p.x, s.x2 - 1) : s.x1;
      const x2 = r ? Math.max(p.x, s.x1 + 1) : s.x2;
      const y1 = b ? Math.min(p.y, s.y2 - 1) : s.y1;
      const y2 = t ? Math.max(p.y, s.y1 + 1) : s.y2;
      box = { x1, x2, y1, y2 };
    }
  };
  plot.addEventListener("pointermove", (e) => {
    if (!drag) return hover(e);
    dragTo(e);
    draw();
    apply();
  });
  const endDrag = (e?: PointerEvent) => {
    if (!drag) return;
    if (e?.type === "pointerup") dragTo(e); // moves can be coalesced, so the release position counts too
    // A click without a drag doesn't make a box.
    if (drag.mode === "new" && box.x2 - box.x1 < 2 && box.y2 - box.y1 < 2) box = drag.start;
    drag = null;
    draw();
    apply(true);
  };
  plot.addEventListener("pointerup", endDrag);
  plot.addEventListener("pointercancel", () => endDrag());
  plot.addEventListener("lostpointercapture", () => endDrag());
  plot.addEventListener("pointerleave", () => (tip.hidden = true));

  updaters.push((data, q) => {
    if (!drag) box = readBox(q); // follow Clear filters and Back
    points = data.colourPoints ?? [];
    drawDots();
    draw();
  });
  draw();
  return card;
}

function buildPrimary() {
  const primary = defs.find((d) => d.group === "primary");
  if (!primary) return;
  const select = $<HTMLSelectElement>("primary-select");
  select.addEventListener("change", () => navigate(setParam(primary.id, select.value || null)));
  updaters.push((data, q) => {
    const selected = q.get(primary.id);
    select.replaceChildren(
      el("option", { value: "", text: "Any" }),
      ...(primary.options ?? []).map((o) => {
        const n = data.facets[primary.id]?.[o.id] ?? 0;
        return el("option", { value: o.id, selected: o.id === selected, disabled: n === 0 && o.id !== selected, text: `${o.label} (${n})` });
      }),
    );
  });
}

// Yes/no tags (people, wildlife, birds): Any / With / Without, each with its photo count.
function buildPresence() {
  const rows = defs
    .filter((d) => d.group === "presence")
    .map((d) => {
      const options: [string | null, string][] = [
        [null, "Any"],
        ["true", "With"],
        ["false", "Without"],
      ];
      const buttons = options.map(([v]) => {
        const b = el("button", { type: "button", role: "radio" });
        b.addEventListener("click", () => navigate(setParam(d.id, v)));
        return b;
      });
      updaters.push((data, q) => {
        const value = q.get(d.id);
        buttons.forEach((b, i) => {
          const [v, label] = options[i]!;
          b.setAttribute("aria-checked", String(value === v));
          b.textContent = v == null ? label : `${label} (${data.facets[d.id]?.[v] ?? 0})`;
        });
      });
      return el(
        "div",
        { class: "presence-row" },
        el("span", { class: "presence-name", text: d.label }),
        el("div", { class: "seg seg-small", role: "radiogroup", "aria-label": d.label }, ...buttons),
      );
    });
  $("presence").replaceChildren(...rows);
}

// Chip groups (activities, weather & sky, water, palette): yes/no tags toggle "true"; choice and multi
// tags show one chip per option. Each chip shows how many photos it would match.
function buildTagChips(group: AttributeDef["group"]) {
  const chips: HTMLElement[] = [];
  for (const d of defs.filter((x) => x.group === group && !isNumeric(x))) {
    const entries = d.kind === "boolean" ? [{ id: "true", label: d.label, swatch: undefined as string | undefined }] : (d.options ?? []);
    for (const o of entries) {
      const count = el("span", { class: "chip-count" });
      const swatch = o.swatch ? el("span", { class: "swatch", style: `background:${o.swatch}` }) : null;
      const chip = el("button", { class: "chip", type: "button", title: d.kind === "boolean" ? "" : d.label }, swatch, o.label, count);
      // Multi tags (the palette) select any number of values, matching photos with any of them.
      const selected = (q: URLSearchParams) => (q.get(d.id) ?? "").split(",").filter(Boolean);
      chip.addEventListener("click", () => {
        if (d.kind !== "multi") return navigate(setParam(d.id, params().get(d.id) === o.id ? null : o.id));
        const cur = selected(params());
        const next = cur.includes(o.id) ? cur.filter((x) => x !== o.id) : [...cur, o.id];
        navigate(setParam(d.id, next.length ? (d.options ?? []).filter((x) => next.includes(x.id)).map((x) => x.id).join(",") : null));
      });
      updaters.push((data, q) => {
        const on = d.kind === "multi" ? selected(q).includes(o.id) : q.get(d.id) === o.id;
        const n = data.facets[d.id]?.[o.id] ?? 0;
        chip.setAttribute("aria-pressed", String(on));
        chip.disabled = !on && n === 0;
        count.textContent = String(n);
      });
      chips.push(chip);
    }
  }
  $(`chips-${group}`).replaceChildren(...chips);
  ($(`chips-${group}`).closest(".filter-group") as HTMLElement).hidden = !chips.length;
  // The palette: match only each photo's primary (first) colour.
  for (const d of defs.filter((x) => x.group === group && x.kind === "multi")) {
    const key = `${d.id}_primary`;
    const toggle = checkToggle("Primary colour only", false, (on) => navigate(setParam(key, on ? "1" : null), { replace: true }));
    toggle.title = "Match only each photo's main colour, not its second one";
    updaters.push((_d, q) => setChecked(toggle, q.get(key) === "1"));
    $(`chips-${group}`).after(toggle);
  }
}

// A small checkbox-style button: an empty square when off, a ticked one when on.
function checkToggle(label: string, on: boolean, onChange: (on: boolean) => void) {
  const b = el(
    "button",
    { type: "button", class: "check-toggle", "aria-pressed": String(on) },
    svgCheck(),
    label,
  );
  b.addEventListener("click", () => {
    const next = b.getAttribute("aria-pressed") !== "true";
    setChecked(b, next);
    onChange(next);
  });
  return b;
}
const setChecked = (b: HTMLElement, on: boolean) => b.setAttribute("aria-pressed", String(on));
function svgCheck() {
  const s = svg("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
  s.append(svg("rect", { x: 3.5, y: 3.5, width: 17, height: 17, rx: 3.5 }), svg("path", { class: "check", d: "M7.5 12.5l3 3 6-7" }));
  return s;
}

// ---- Map view (experimental): the 3D cube, plus plot helpers shared with the colour picker ----

const SVG_NS = "http://www.w3.org/2000/svg";
const MAP_PAD = 3; // plot margin in plot units, so dots on the edges show in full
// Plot units (0–100) → % of the padded plot box, for HTML placed over or beside it.
const padPct = (n: number) => ((n + MAP_PAD) / (100 + 2 * MAP_PAD)) * 100;

// The colour axis: a grey neutral band at the bottom, then the hue axis from 12 to 100
// (red → orange → yellow → green → teal → blue → purple → pink; storage.ts turns the wheel by 15°).
const hueStrip = (direction: string) =>
  `linear-gradient(${direction}, #9a9a96 0%, #9a9a96 10%, transparent 10%, transparent 12%, ${Array.from(
    { length: 13 },
    (_, k) => `hsl(${k * 30 - 15} 70% 55%) ${12 + (k * 88) / 12}%`,
  ).join(", ")})`;

// Name and swatch for a position on the colour axis (the inverse of colourY in server/photos.ts).
const HUE_NAMES: [number, string][] = [[15, "Red"], [45, "Orange"], [70, "Yellow"], [160, "Green"], [195, "Teal"], [255, "Blue"], [290, "Purple"], [345, "Pink"], [360, "Red"]];
function colourAt(y: number) {
  if (y < 11) return { name: "Neutral", swatch: "#9a9a96" };
  const hue = ((Math.max(12, y) - 12) / 88) * 360 - 15;
  const h = (hue + 360) % 360;
  return { name: HUE_NAMES.find(([max]) => h < max)![1], swatch: `hsl(${hue} 70% 55%)` };
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

// ---- 3D cube ----
// One cube: water → mountains across (x), main colour up (y), scale (macro → vista) in depth (z), drawn as SVG with
// a simple rotation and orthographic projection. Drag to rotate; click a dot to move the pointer onto it;
// the axis sliders nudge it and the size slider grows it into a sphere. URL: m3=x,y,z,radius.

const MAP_MAX_RADIUS = 174; // covers the whole cube from any point (√3 × 100)
const VIEW_3D = 1.8; // half-width of the viewBox: a rotated cube reaches √3 ≈ 1.73 from its centre
type Vec3 = [number, number, number];

// The pointer from the address (m3=x,y,z,r). Without one the map is off; the sliders then sit at a
// starting pointer (the centre, a modest sphere) that turns the map on as soon as it's moved.
function parsePointer3(v: string | null) {
  const m = v ? /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?),(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(v) : null;
  return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]), r: Number(m[4]) } : { x: 50, y: 50, z: 50, r: 25 };
}

// Places on the water → mountains axis (server/photos.ts WATER_TO_MOUNTAINS); between two it reads
// "Water – Foothills". Foothills is everything between the water and the mountains.
const AXIS_PLACES: [number, string][] = [[0, "Water"], [50, "Foothills"], [100, "Mountains"]];
function placeLabel(x: number) {
  const near = AXIS_PLACES.find(([at]) => Math.abs(at - x) <= 5);
  if (near) return near[1];
  const i = AXIS_PLACES.findIndex(([at]) => at > x);
  return `${AXIS_PLACES[i - 1]![1]} – ${AXIS_PLACES[i]![1]}`;
}

function buildMap3D() {
  let ptr = parsePointer3(params().get("m3"));
  let on = params().has("m3"); // a pointer is placed, so the map filters
  let points: MapPoint[] = [];
  let yaw = -0.65; // rotation about the vertical axis, then tilt toward the viewer
  let pitch = 0.4;
  let held = false; // a slider is being dragged
  let gesture: { x: number; y: number; yaw: number; pitch: number; moved: boolean } | null = null;

  // Cube coordinates (0–100) → screen (viewBox ±VIEW_3D), plus depth for drawing order.
  const project = ([x, y, z]: Vec3) => {
    const px = (x - 50) / 50, py = (y - 50) / 50, pz = (z - 50) / 50;
    const x1 = px * Math.cos(yaw) - pz * Math.sin(yaw);
    const z1 = px * Math.sin(yaw) + pz * Math.cos(yaw);
    const y2 = py * Math.cos(pitch) - z1 * Math.sin(pitch);
    const z2 = py * Math.sin(pitch) + z1 * Math.cos(pitch);
    return { sx: x1, sy: -y2, depth: z2 };
  };
  const SCALE = 1 / 50; // cube units → viewBox units (orthographic, so spheres stay circles)

  const plot = svg("svg", { viewBox: `${-VIEW_3D} ${-VIEW_3D} ${2 * VIEW_3D} ${2 * VIEW_3D}`, class: "map3d-plot", role: "img", "aria-label": "3D map" });
  const edges = svg("g", { class: "map3d-edges" });
  const labels = svg("g", { class: "map3d-labels" });
  const dots = svg("g", { class: "map-dots" });
  const sphere = svg("circle", { class: "map-circle map3d-sphere" });
  const cross = svg("g", { class: "map3d-cross" });
  plot.append(edges, labels, sphere, dots, cross); // dots over the sphere so matches stay visible

  const tipImg = el("img", { alt: "" });
  const tipText = el("span");
  const tip = el("div", { class: "map-tip", hidden: true }, tipImg, tipText);

  // Sliders laid out like the Sliders view's cards: name and value on top, the track below. Each axis has
  // its own colour (axis-x/y/z), shared by its slider and its edge and labels in the cube.
  const slider = (label: string, max: number, axis = "") => {
    const input = el("input", { type: "range", min: "0", max: String(max), step: "1", "aria-label": label });
    const value = el("span", { class: "slider-value" });
    const head = el("div", { class: "slider-head" }, el("span", { class: "slider-name", text: label }), value);
    const range = el("div", { class: "range" }, el("span", { class: "range-track" }), input);
    return { input, value, range, row: el("div", { class: `slider-card map-slider ${axis}` }, head, range) };
  };
  const sx = slider("Water → Mtns", 100, "axis-x");
  sx.input.setAttribute("aria-label", "Water → mountains");
  const sy = slider("Colour", 100, "axis-y");
  // A colour strip under the track (stretched like the axis, see colourAxis), and the colour's name.
  const hueStripEl = el("span", { class: "map-hue-strip" });
  sy.range.after(hueStripEl);
  const swatch = el("span", { class: "map-hue-swatch" });
  const sz = slider("Scale", 100, "axis-z");
  const scaleDef = defs.find((d) => d.id === "scale");
  const size = slider("Pointer size", MAP_MAX_RADIUS);
  // The stretched colour axis from the server: cube position → position on the even colour axis.
  let colourAxis: [number, number][] = [];
  const colourAtCube = (y: number) => {
    if (y < 11 || !colourAxis.length) return colourAt(y);
    const i = colourAxis.findIndex(([at]) => at >= y);
    if (i <= 0) return colourAt(colourAxis[Math.max(0, i)]![1]);
    const [y0, v0] = colourAxis[i - 1]!, [y1, v1] = colourAxis[i]!;
    return colourAt(v0 + ((v1 - v0) * (y - y0)) / (y1 - y0));
  };
  const drawHueStrip = () => {
    const stops = ["#9a9a96 0%", "#9a9a96 10%", "transparent 10%", "transparent 12%", ...colourAxis.map(([y, v]) => `${colourAt(v).swatch} ${y}%`)];
    hueStripEl.style.background = colourAxis.length ? `linear-gradient(to right, ${stops.join(", ")})` : hueStrip("to right");
  };
  const reset = el("button", { type: "button", class: "link-btn small", text: "Reset view" });
  const clear = el("button", { type: "button", class: "slider-clear", title: "Turn the map filter off", "aria-label": "Turn the map filter off", text: "×" });
  clear.addEventListener("click", () => navigate(setParam("m3", null), { replace: true }));
  $("map-c").replaceChildren(
    el(
      "div",
      { class: "map-head" },
      el("span", { class: "slider-name", text: "Water to mountains · Colour · Scale" }),
      el("span", { class: "slider-head-right" }, reset, clear),
    ),
    el("div", { class: "map-plot-wrap" }, plot, tip),
    el("p", { class: "filter-note", text: "Drag to turn the cube. Click a dot to move the pointer onto it; hover to preview." }),
    sx.row,
    sy.row,
    sz.row,
    size.row,
  );

  const corner = (i: number): Vec3 => [i & 1 ? 100 : 0, i & 2 ? 100 : 0, i & 4 ? 100 : 0];
  const line = (a: Vec3, b: Vec3, cls: string) => {
    const p = project(a), q = project(b);
    return svg("line", { x1: p.sx, y1: p.sy, x2: q.sx, y2: q.sy, class: cls });
  };
  const text = (at: Vec3, label: string, cls = "") => {
    const p = project(at);
    const t = svg("text", { x: p.sx, y: p.sy, class: cls });
    t.textContent = label;
    return t;
  };

  const draw = () => {
    // 12 edges; the three from the origin corner are the axes (colour axis drawn with the hue gradient).
    const all: SVGElement[] = [];
    for (let i = 0; i < 8; i++) {
      for (const bit of [1, 2, 4]) {
        if (i & bit) continue;
        const axis = i === 0;
        all.push(line(corner(i), corner(i | bit), axis ? (bit === 1 ? "axis axis-x" : bit === 2 ? "axis axis-y" : "axis axis-z") : ""));
      }
    }
    edges.replaceChildren(...all);
    labels.replaceChildren(
      text([0, -8, 0], "Water", "end-label axis-x"),
      text([100, -8, 0], "Mountains", "end-label axis-x"),
      text([0, 106, 0], "Colour", "end-label axis-y"),
      text([0, -8, 100], "Vista", "end-label axis-z"),
      text([50, -8, 0], "Foothills", "axis-label axis-x"),
      text([0, -8, 50], "Macro → vista", "axis-label axis-z"),
    );

    // Dots, farthest first so nearer ones overlap them; slightly larger when nearer.
    const placed = points.map((p) => ({ p, s: project(p.pos) })).sort((a, b) => a.s.depth - b.s.depth);
    dots.replaceChildren(
      ...placed.map(({ p, s }) =>
        svg("circle", { cx: s.sx, cy: s.sy, r: (p.match ? 0.055 : 0.04) * (1 + s.depth * 0.15), class: p.match ? "match" : "" }),
      ),
    );

    // Off: no sphere or pointer, every dot plain.
    $("map-c").classList.toggle("on", on);
    clear.hidden = !on;
    sphere.style.display = cross.style.display = on ? "" : "none";
    const c = project([ptr.x, ptr.y, ptr.z]);
    sphere.setAttribute("cx", String(c.sx));
    sphere.setAttribute("cy", String(c.sy));
    sphere.setAttribute("r", String(ptr.r * SCALE));
    // The pointer: three short lines along the cube's axes, so its depth reads as you rotate.
    cross.replaceChildren(
      line([ptr.x - 6, ptr.y, ptr.z], [ptr.x + 6, ptr.y, ptr.z], ""),
      line([ptr.x, ptr.y - 6, ptr.z], [ptr.x, ptr.y + 6, ptr.z], ""),
      line([ptr.x, ptr.y, ptr.z - 6], [ptr.x, ptr.y, ptr.z + 6], ""),
    );
    for (const [s, v] of [
      [sx, ptr.x],
      [sy, ptr.y],
      [sz, ptr.z],
    ] as const) {
      if (!held) s.input.value = String(Math.round(v));
      s.value.textContent = String(Math.round(v));
    }
    sx.value.textContent = placeLabel(ptr.x);
    if (scaleDef) sz.value.textContent = levelLabel(scaleDef, ptr.z); // e.g. "Macro", "Vista"
    const colour = colourAtCube(ptr.y);
    swatch.style.background = colour.swatch;
    sy.value.replaceChildren(swatch, colour.name);
    if (!held) size.input.value = String(ptr.r);
    size.value.textContent = !on ? "Off" : ptr.r <= 0 ? "Point" : ptr.r >= MAP_MAX_RADIUS ? "Everything" : String(Math.round(ptr.r));
  };

  // Placing or moving the pointer turns the map on. One decimal place, so a pointer placed on a dot sits
  // exactly on it.
  const apply = (commit = false) => {
    on = true;
    navigate(setParam("m3", [ptr.x, ptr.y, ptr.z, ptr.r].map((n) => Math.round(n * 10) / 10).join(",")), { replace: true, live: !commit });
  };

  // Screen position of a pointer event in viewBox units.
  const at = (e: PointerEvent) => {
    const r = plot.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width - 0.5) * 2 * VIEW_3D, y: ((e.clientY - r.top) / r.height - 0.5) * 2 * VIEW_3D };
  };
  const nearestDot = (e: PointerEvent) => {
    const { x, y } = at(e);
    let best: { p: MapPoint; d: number; s: ReturnType<typeof project> } | null = null;
    for (const p of points) {
      const s = project(p.pos);
      const d = Math.hypot(s.sx - x, s.sy - y);
      // Within ~0.09 units (a few pixels); the nearer dot wins when two overlap on screen.
      if (d < 0.09 && (!best || s.depth > best.s.depth)) best = { p, d, s };
    }
    return best;
  };
  const hover = (e: PointerEvent) => {
    const hit = nearestDot(e);
    tip.hidden = !hit;
    if (!hit) return;
    tipImg.src = hit.p.thumbUrl;
    tipText.textContent = hit.p.title;
    const left = ((hit.s.sx + VIEW_3D) / (2 * VIEW_3D)) * 100, topPct = ((hit.s.sy + VIEW_3D) / (2 * VIEW_3D)) * 100;
    tip.style.left = `${left}%`;
    tip.style.top = `${topPct}%`;
    tip.classList.toggle("left", left > 55);
    tip.classList.toggle("below", topPct < 40);
  };

  plot.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    plot.setPointerCapture(e.pointerId);
    gesture = { x: e.clientX, y: e.clientY, yaw, pitch, moved: false };
    tip.hidden = true;
  });
  plot.addEventListener("pointermove", (e) => {
    if (!gesture) return hover(e);
    const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
    if (Math.hypot(dx, dy) > 4) gesture.moved = true;
    if (!gesture.moved) return;
    yaw = gesture.yaw + dx * 0.01;
    pitch = Math.max(-1.45, Math.min(1.45, gesture.pitch + dy * 0.01));
    draw();
  });
  plot.addEventListener("pointerup", (e) => {
    const g = gesture;
    gesture = null;
    if (!g || g.moved) return;
    // A click, not a drag: move the pointer onto the dot under it.
    const hit = nearestDot(e);
    if (!hit) return;
    [ptr.x, ptr.y, ptr.z] = hit.p.pos;
    draw();
    apply(true);
  });
  plot.addEventListener("pointercancel", () => (gesture = null));
  plot.addEventListener("pointerleave", () => (tip.hidden = true));
  reset.addEventListener("click", () => {
    yaw = -0.65;
    pitch = 0.4;
    draw();
  });

  for (const [s, key] of [
    [sx, "x"],
    [sy, "y"],
    [sz, "z"],
    [size, "r"],
  ] as const) {
    s.input.addEventListener("pointerdown", () => (held = true));
    s.input.addEventListener("input", () => {
      ptr = { ...ptr, [key]: Number(s.input.value) };
      draw();
      apply();
    });
    s.input.addEventListener("change", () => {
      held = false;
      apply(true);
    });
  }
  window.addEventListener("pointerup", () => {
    if (!held) return;
    held = false;
    apply(true);
  });

  updaters.push((data, q) => {
    if (!held) {
      ptr = parsePointer3(q.get("m3"));
      on = q.has("m3");
    }
    points = data.mapPoints ?? [];
    colourAxis = data.colourAxis ?? [];
    drawHueStrip();
    draw();
  });
  draw();
}

function updateSummary(data: PhotoListResponse, q: URLSearchParams) {
  // Tag filters plus the colour picker's colour range and the 3D map's sphere, which aren't tags.
  const active = defs.filter((d) => q.has(d.id)).length + (q.has("hue") ? 1 : 0) + (q.has("m3") ? 1 : 0);
  $("clear").hidden = !active;
  const s = data.total === 1 ? "" : "s";
  const text = active ? `${data.photos.length} of ${data.total} photo${s}` : `${data.total} photo${s}`;
  $("count").textContent = text;
  $("count-side").textContent = text;
  $("filters-badge").textContent = String(active);
  $("filters-badge").hidden = !active;
}

// ---- Collapsible sections ----
// Every [data-section] in the sidebar gets its title turned into a toggle and the rest wrapped in a body.
// Collapsed sections are remembered per browser; a collapsed section with active filters says so.
const SECTIONS_KEY = "pan.collapsedSections";
function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
function saveCollapsed(keys: Set<string>) {
  try {
    localStorage.setItem(SECTIONS_KEY, JSON.stringify([...keys]));
  } catch {
    // storage unavailable; the choice just isn't remembered
  }
}

// Active filters inside a section body: pressed chips, narrowed sliders and pickers, presence rows other
// than "Any", and a chosen primary subject.
function activeIn(body: HTMLElement) {
  return (
    body.querySelectorAll('.chip[aria-pressed="true"], .slider-value.active, .map-card.on').length +
    [...body.querySelectorAll(".presence-row")].filter((row) => row.querySelector('[role="radio"][aria-checked="true"]') !== row.querySelector('[role="radio"]')).length +
    [...body.querySelectorAll("select")].filter((sel) => sel.value !== "").length
  );
}

function buildSections() {
  const collapsed = loadCollapsed();
  const badges: [HTMLElement, HTMLElement][] = [];
  for (const section of document.querySelectorAll<HTMLElement>(".sidebar [data-section]")) {
    const key = section.dataset.section!;
    const title = section.querySelector<HTMLElement>(":scope > .filter-label")!;
    const body = el("div", { class: "section-body", id: `section-${key}` });
    for (const child of [...section.children]) if (child !== title) body.append(child);
    const badge = el("span", { class: "section-badge", hidden: true });
    const toggle = el("button", { type: "button", class: "section-toggle", "aria-controls": body.id }, el("span", { class: "section-chevron", "aria-hidden": "true" }), title.textContent ?? "", badge);
    // An h2 keeps its heading role with the button inside it; a plain label is replaced by the button.
    if (title.tagName === "H2") title.replaceChildren(toggle);
    else title.replaceWith(toggle);
    section.append(body);
    section.classList.add("section");
    const set = (closed: boolean) => {
      section.classList.toggle("collapsed", closed);
      body.hidden = closed;
      toggle.setAttribute("aria-expanded", String(!closed));
    };
    // Sections marked data-collapsed-default (the 3D map) start closed; opening one is remembered as "key:open".
    const closedByDefault = section.hasAttribute("data-collapsed-default");
    set(closedByDefault ? !collapsed.has(`${key}:open`) : collapsed.has(key));
    toggle.addEventListener("click", () => {
      const closed = !section.classList.contains("collapsed");
      set(closed);
      const remembered = closedByDefault ? `${key}:open` : key;
      if (closed === closedByDefault) collapsed.delete(remembered);
      else collapsed.add(remembered);
      saveCollapsed(collapsed);
    });
    badges.push([body, badge]);
  }
  // Runs after the other updaters (built later than the controls), so it counts their updated state.
  updaters.push(() => {
    for (const [body, badge] of badges) {
      const n = activeIn(body);
      badge.hidden = n === 0;
      badge.textContent = `${n} active`;
    }
  });
}

// ---- Grid & lightbox ----

function photoTitle(p: PublicPhoto) {
  return p.title ?? p.name;
}

// "12 Jul 2023" from an EXIF "YYYY-MM-DDTHH:MM:SS" (read as is: it's the camera's local time).
function takenLabel(takenAt: string | null) {
  const m = takenAt ? /^(\d{4})-(\d{2})-(\d{2})/.exec(takenAt) : null;
  if (!m) return "Unknown";
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function renderGrid() {
  const sortKey = params().get("sort");
  const sortDef = showSortValue ? defs.find((d) => d.id === sortKey) : undefined;
  const showDate = showSortValue && sortKey === "newest"; // Newest first shows the date taken; Random shows nothing
  const showNumber = showSortValue && sortKey === "number";
  grid.replaceChildren(
    ...photos.map((p, i) => {
      const card = el(
        "button",
        { class: "tile", type: "button", "aria-label": `Open ${photoTitle(p)}` },
        el("img", { src: p.thumbUrl, alt: p.title ?? "", loading: "lazy", decoding: "async" }),
        sortDef && p.attrs[sortDef.id] != null ? el("span", { class: "tile-badge", text: `${sortDef.label}: ${valueLabel(sortDef, p.attrs[sortDef.id])}` }) : null,
        showDate ? el("span", { class: "tile-badge", text: `Date: ${takenLabel(p.takenAt)}` }) : null,
        showNumber ? el("span", { class: "tile-badge", text: p.name }) : null,
        p.title ? el("span", { class: "tile-title", text: p.title }) : null,
      );
      card.addEventListener("click", () => openLightbox(i));
      return card;
    }),
  );
  empty.hidden = photos.length > 0;
  empty.textContent = defs.some((d) => params().has(d.id)) ? "No photos match these filters." : "No photos yet.";
}

function openLightbox(i: number) {
  const p = photos[i];
  if (p) showPhoto(p, i);
}

// Bounding boxes in the lightbox: off by default, remembered per browser.
const BOXES_KEY = "lightbox-boxes";
let showBoxes = false;
try {
  showBoxes = localStorage.getItem(BOXES_KEY) === "1";
} catch {
  // storage unavailable
}

// Draws the shown photo's boxes over the part of the stage the image fills (it's letterboxed by
// object-fit: contain, so the element's box is larger than the picture).
function drawBoxes() {
  const img = $<HTMLImageElement>("lb-img");
  const layer = $("lb-boxes");
  const toggle = $("lb-boxes-toggle");
  const boxes = shown?.boxes ?? [];
  $("lb-boxes-group").hidden = boxes.length === 0;
  if (!boxes.length) setBoxesNote(false);
  toggle.setAttribute("aria-pressed", String(showBoxes));
  toggle.querySelector("span")!.textContent = showBoxes ? "Hide boxes" : "Show boxes";
  layer.hidden = !showBoxes || boxes.length === 0 || !img.complete || !img.naturalWidth;
  if (layer.hidden) return;
  const scale = Math.min(img.clientWidth / img.naturalWidth, img.clientHeight / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  Object.assign(layer.style, {
    left: `${img.offsetLeft + (img.clientWidth - w) / 2}px`,
    top: `${img.offsetTop + (img.clientHeight - h) / 2}px`,
    width: `${w}px`,
    height: `${h}px`,
  });
  layer.replaceChildren(
    ...boxes.map((b) => {
      const boxEl = el("div", { class: `box box-${b.id}` });
      placeBox(boxEl, b.box, b.label);
      return boxEl;
    }),
  );
}

// Shows a photo in the lightbox; index is its place in the gallery.
function showPhoto(p: PublicPhoto, index: number) {
  current = index;
  shown = p;
  const img = $<HTMLImageElement>("lb-img");
  img.src = p.displayUrl;
  img.alt = p.title ?? "";
  drawBoxes(); // hides the old photo's boxes until this one has loaded
  $("lb-title").textContent = photoTitle(p);
  $("lb-desc").textContent = p.description ?? "";
  $("lb-desc").hidden = !p.description;

  const unsureMark = (d: AttributeDef) => (p.unsure.includes(d.id) ? el("span", { class: "unsure-mark", title: "Jev was split between quite different answers", text: "?" }) : null);

  // Primary subject first, then who's in it, then the other yes/no tags, categories and palette.
  const tags: HTMLElement[] = [];
  const order: AttributeDef["group"][] = ["primary", "presence", "activity", "sky", "colour"];
  for (const group of order) {
    for (const d of defs.filter((x) => x.group === group)) {
      const v = p.attrs[d.id];
      if (v == null) continue;
      if (d.group === "primary") tags.push(el("span", { class: "tag tag-main", text: `Primary: ${valueLabel(d, v)}` }));
      else if (d.kind === "boolean" && v === "true") tags.push(el("span", { class: `tag${d.group === "presence" ? " tag-person" : ""}`, text: d.label }));
      else if (d.kind === "boolean" && v === "uncertain" && d.group === "presence")
        tags.push(el("span", { class: "tag tag-unsure", title: "Jev couldn't tell", text: `${d.label}?` }));
      else if (d.kind === "choice") tags.push(el("span", { class: "tag", text: `${d.label}: ${valueLabel(d, v)}` }));
      else if (d.kind === "multi")
        for (const id of v.split(",")) {
          const o = d.options?.find((x) => x.id === id);
          tags.push(el("span", { class: "tag" }, o?.swatch ? el("span", { class: "swatch", style: `background:${o.swatch}` }) : null, o?.label ?? id));
        }
    }
  }
  $("lb-tags").replaceChildren(...tags);

  // Coverage: every category judged present, largest first. Each is estimated on its own, so the
  // shares can add up to more than 100% (snow overlaps what it covers).
  const cover = defs.filter((d) => d.kind === "percent" && p.contains.includes(d.id)).sort((a, b) => Number(p.attrs[b.id] ?? 0) - Number(p.attrs[a.id] ?? 0));
  $("lb-cover").replaceChildren(
    ...(cover.length ? [el("h3", { class: "filter-label", text: "Approximate coverage" })] : []),
    ...cover.map((d) => {
      const n = Number(p.attrs[d.id] ?? 0);
      return el(
        "div",
        { class: "lb-bar", title: `About ${Math.round(n)}% of the frame (a rough estimate)` },
        el("span", {}, d.label, unsureMark(d)),
        el("span", { class: "track" }, el("span", { class: "fill on", style: `width:${Math.min(100, Math.max(2, n))}%` })),
        el("span", { class: "lb-num", text: coverWord(n, true) }),
      );
    }),
  );

  const scaleRows = (group: AttributeDef["group"], title: string) => {
    const list = defs.filter((d) => d.group === group && d.kind === "scale" && p.attrs[d.id] != null);
    return list.length ? [el("h3", { class: "filter-label", text: title }), ...list.map(scaleRow)] : [];
  };
  const scaleRow = (d: AttributeDef) => {
    const n = Number(p.attrs[d.id]);
    return el(
      "div",
      { class: "lb-mood" },
      el("span", {}, d.label, unsureMark(d)),
      el("span", { class: "mood-scale" }, el("span", { class: "mood-dot", style: `left:${n}%` })),
      el("span", { class: "lb-num", text: levelLabel(d, n) }),
    );
  };
  $("lb-moods").replaceChildren(...scaleRows("mood", "Mood"), ...scaleRows("colour", "Colour"), ...scaleRows("look", "Look & composition"));

  const dims = p.width && p.height ? ` · ${p.width}×${p.height}` : "";
  $("lb-file").textContent = `${p.name}${dims}`;

  $<HTMLButtonElement>("lb-prev").disabled = index <= 0;
  $<HTMLButtonElement>("lb-next").disabled = index < 0 || index === photos.length - 1;
  if (!lightbox.open) lightbox.showModal();
  $("lb-info").scrollTop = 0;
}

// Filtering runs here, over data.json (shared/gallery.ts); there's no server to ask.
function load() {
  const galleryQuery = params();
  if (!galleryQuery.has("seed")) galleryQuery.set("seed", pageSeed);
  const data = gallery.query(galleryQuery);
  photos = data.photos;
  const q = params();
  for (const update of updaters) update(data, q);
  updateSummary(data, q);
  renderGrid();
}

// ---- Sidebar: collapsible tab on desktop, slide-out drawer on phones ----

const SIDEBAR_KEY = "pan.sidebarCollapsed";
const layout = $("layout");
const drawerQuery = window.matchMedia("(max-width: 820px)");

function setCollapsed(collapsed: boolean) {
  layout.classList.toggle("collapsed", collapsed);
  const tab = $("sidebar-tab");
  tab.setAttribute("aria-expanded", String(!collapsed));
  tab.title = collapsed ? "Show filters" : "Hide filters";
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
  } catch {
    // storage unavailable (private mode); the choice just isn't remembered
  }
}

function setDrawer(open: boolean) {
  layout.classList.toggle("drawer-open", open);
  $("drawer-backdrop").hidden = !open;
  $("filters-open").setAttribute("aria-expanded", String(open));
  if (open) $("filters-close").focus();
}

$("sidebar-tab").addEventListener("click", () => setCollapsed(!layout.classList.contains("collapsed")));
$("filters-open").addEventListener("click", () => {
  if (drawerQuery.matches) setDrawer(true);
  else setCollapsed(false);
});
$("filters-close").addEventListener("click", () => setDrawer(false));
$("drawer-backdrop").addEventListener("click", () => setDrawer(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && layout.classList.contains("drawer-open") && !lightbox.open) setDrawer(false);
});
drawerQuery.addEventListener("change", () => setDrawer(false));
try {
  setCollapsed(localStorage.getItem(SIDEBAR_KEY) === "1");
} catch {
  setCollapsed(false);
}

// Clears what updateSummary counts: the tag filters (saturation among them), the colour picker's colour
// range and the 3D map's sphere.
$("clear").addEventListener("click", () =>
  navigate((q) => {
    for (const d of defs) q.delete(d.id);
    q.delete("hue");
    q.delete("m3");
  }),
);
$("lb-close").addEventListener("click", () => lightbox.close());
$("lb-prev").addEventListener("click", () => openLightbox(current - 1));
$("lb-next").addEventListener("click", () => openLightbox(current + 1));
lightbox.addEventListener("click", (e) => {
  if (e.target === lightbox) lightbox.close(); // backdrop click
});
lightbox.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") openLightbox(current - 1);
  if (e.key === "ArrowRight") openLightbox(current + 1);
});
// ---- Gallery view ----

const viewer = $<HTMLDialogElement>("viewer");
// Two stacked layers, so the slideshow can crossfade: the "front" one is visible, the other waits behind it.
const viewerLayers = [$<HTMLImageElement>("viewer-img"), $<HTMLImageElement>("viewer-img-2")];
let frontLayer = 0;
const viewerImg = () => viewerLayers[frontLayer]!;
let viewerIndex = -1; // index into photos
let idleTimer: number | undefined;
let viewSeq = 0; // a newer photo cancels a crossfade still waiting for its image

// Shows a photo in gallery view. `fade` (the slideshow's own advance, with Crossfade on) loads it into the
// back layer and fades it in once loaded; anything else (‹ ›, keys, swipes, opening) switches at once.
function showInViewer(p: PublicPhoto, index: number, fade = false) {
  viewerIndex = index;
  shown = p;
  const seq = ++viewSeq;
  const alt = p.title ?? photoTitle(p);
  if (fade && crossfade) {
    const next = viewerLayers[1 - frontLayer]!;
    const reveal = () => {
      if (seq !== viewSeq) return;
      viewer.style.setProperty("--fade-ms", `${fadeMs()}ms`);
      next.classList.add("front");
      viewerImg().classList.remove("front");
      viewerImg().alt = "";
      next.alt = alt;
      frontLayer = 1 - frontLayer;
      if (slideshow) restartSlide();
    };
    next.src = p.displayUrl;
    if (next.complete && next.naturalWidth) reveal();
    else {
      next.addEventListener("load", reveal, { once: true });
      next.addEventListener("error", reveal, { once: true });
    }
  } else {
    viewer.style.setProperty("--fade-ms", "0ms");
    viewerImg().src = p.displayUrl;
    viewerImg().alt = alt;
    if (slideshow) restartSlide();
  }
  // A slideshow loops, so it always has a previous and next photo (when there's more than one).
  const loop = slideshow && photos.length > 1;
  $<HTMLButtonElement>("viewer-prev").disabled = !loop && index <= 0;
  $<HTMLButtonElement>("viewer-next").disabled = !loop && (index < 0 || index >= photos.length - 1);
  // Fetch the neighbours ahead of time so stepping through feels instant.
  for (const n of [photos.at(index - 1), photos[(index + 1) % photos.length]]) if (index >= 0 && n) new Image().src = n.displayUrl;
}

function stepViewer(delta: number, fade = false) {
  if (viewerIndex < 0) return;
  const i = slideshow ? (viewerIndex + delta + photos.length) % photos.length : viewerIndex + delta;
  const p = photos[i];
  if (p) showInViewer(p, i, fade);
}

// ---- Slideshow: gallery view going through the filtered photos on a timer, looping, full screen ----

const SLIDE_SECONDS_KEY = "slideshow-seconds";
const CROSSFADE_KEY = "slideshow-crossfade";
const clampSeconds = (n: number) => Math.min(60, Math.max(3, Math.round(n)));
let slideSeconds = 5;
try {
  slideSeconds = clampSeconds(Number(localStorage.getItem(SLIDE_SECONDS_KEY)) || 5);
} catch {
  // storage unavailable
}
let crossfade = true;
try {
  crossfade = localStorage.getItem(CROSSFADE_KEY) !== "0";
} catch {
  // storage unavailable
}
// About a second, but never more than a third of each photo's time.
const fadeMs = () => Math.min(1000, (slideSeconds * 1000) / 3);
let slideshow = false;
let slidePaused = false;
let slideTimer: number | undefined;
let slideSeq = 0; // a newer photo cancels the older one's pending start

// Starts this photo's time once it has loaded, so a slow download doesn't eat into it. With a crossfade,
// the time runs from the start of the fade.
function restartSlide() {
  clearTimeout(slideTimer);
  const seq = ++slideSeq;
  if (!slideshow || slidePaused) return;
  const img = viewerImg();
  const start = () => {
    if (seq !== slideSeq || !slideshow || slidePaused) return;
    slideTimer = window.setTimeout(() => stepViewer(1, true), slideSeconds * 1000);
  };
  if (img.complete && img.naturalWidth) start();
  else {
    // A photo that fails to load still gets its time, so the slideshow doesn't stall.
    img.addEventListener("load", start, { once: true });
    img.addEventListener("error", start, { once: true });
  }
}

function setSlidePaused(paused: boolean) {
  slidePaused = paused;
  const btn = $("viewer-play");
  btn.classList.toggle("paused", paused);
  btn.setAttribute("aria-label", paused ? "Resume slideshow" : "Pause slideshow");
  if (paused) clearTimeout(slideTimer);
  else restartSlide();
}

function startSlideshow() {
  if (!shown || !photos.length) return;
  slideshow = true;
  $("viewer-play").hidden = false;
  openViewer(); // shows the current photo, which starts its timer
  setSlidePaused(false);
  // Real full screen where the browser allows it (not iPhone Safari); the viewer already fills the window.
  viewer.requestFullscreen?.().catch(() => {});
}

function stopSlideshow() {
  if (!slideshow) return;
  slideshow = false;
  clearTimeout(slideTimer);
  $("viewer-play").hidden = true;
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
}

const secondsInput = $<HTMLInputElement>("lb-seconds");
secondsInput.value = String(slideSeconds);
secondsInput.addEventListener("change", () => {
  slideSeconds = clampSeconds(Number(secondsInput.value) || slideSeconds);
  secondsInput.value = String(slideSeconds);
  try {
    localStorage.setItem(SLIDE_SECONDS_KEY, String(slideSeconds));
  } catch {
    // storage unavailable; the choice just isn't remembered
  }
});
// Enter in the seconds box starts the slideshow with that value.
secondsInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  secondsInput.dispatchEvent(new Event("change"));
  startSlideshow();
});
const fadeToggle = $("lb-crossfade");
const showCrossfade = () => fadeToggle.setAttribute("aria-pressed", String(crossfade));
showCrossfade();
fadeToggle.addEventListener("click", () => {
  crossfade = !crossfade;
  showCrossfade();
  try {
    localStorage.setItem(CROSSFADE_KEY, crossfade ? "1" : "0");
  } catch {
    // storage unavailable; the choice just isn't remembered
  }
});
$("lb-slideshow").addEventListener("click", startSlideshow);
$("viewer-play").addEventListener("click", () => setSlidePaused(!slidePaused));
// Leaving full screen (Esc) ends the slideshow and the gallery view together.
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && slideshow && viewer.open) viewer.close();
});

function wake() {
  viewer.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => viewer.classList.add("idle"), 2500);
}

function openViewer() {
  if (!shown) return;
  const p = shown;
  lightbox.close();
  showInViewer(p, current);
  viewer.showModal();
  viewer.focus(); // not the first button, which would show a focus ring on open
  wake();
}

$("lb-gallery").addEventListener("click", openViewer);

// Copy link: the site's address with ?photo=<id>, which opens this photo's details (see the end of the file).
const copyLabel = $("lb-copy-link").querySelector(".lb-label")!;
let copyTimer: number | undefined;
$("lb-copy-link").addEventListener("click", async () => {
  if (!shown) return;
  const link = `${location.origin}${location.pathname}?photo=${encodeURIComponent(shown.id)}`;
  let ok = true;
  try {
    await navigator.clipboard.writeText(link);
  } catch {
    // Older browsers, or no permission: select the text in a hidden field and copy that.
    const field = el("textarea", { style: "position:fixed;opacity:0" });
    field.value = link;
    document.body.append(field);
    field.select();
    ok = document.execCommand("copy");
    field.remove();
  }
  copyLabel.textContent = ok ? "Copied" : "Couldn't copy";
  $("lb-copy-link").classList.add("copied");
  clearTimeout(copyTimer);
  copyTimer = window.setTimeout(() => {
    copyLabel.textContent = "Copy link";
    $("lb-copy-link").classList.remove("copied");
  }, 1800);
});
$("lb-img").addEventListener("click", openViewer);
$("lb-img").addEventListener("load", drawBoxes);
new ResizeObserver(drawBoxes).observe($("lb-img"));
// The ? beside Show boxes: hovering shows the note as a tooltip; clicking (or tapping) shows it under the buttons.
function setBoxesNote(open: boolean) {
  $("lb-boxes-note").hidden = !open;
  $("lb-boxes-help").setAttribute("aria-expanded", String(open));
}
$("lb-boxes-help").addEventListener("click", () => setBoxesNote($("lb-boxes-help").getAttribute("aria-expanded") !== "true"));
$("lb-boxes-toggle").addEventListener("click", () => {
  showBoxes = !showBoxes;
  try {
    localStorage.setItem(BOXES_KEY, showBoxes ? "1" : "0");
  } catch {
    // storage unavailable; the choice just isn't remembered
  }
  drawBoxes();
});
$("viewer-prev").addEventListener("click", () => stepViewer(-1));
$("viewer-next").addEventListener("click", () => stepViewer(1));
$("viewer-close").addEventListener("click", () => viewer.close());
// Leaving gallery view (×, Esc) returns to the details of the photo you ended on.
viewer.addEventListener("close", () => {
  clearTimeout(idleTimer);
  stopSlideshow();
  if (shown) showPhoto(shown, viewerIndex);
});
viewer.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") stepViewer(-1);
  if (e.key === "ArrowRight") stepViewer(1);
  if (e.key === " " && slideshow) {
    e.preventDefault();
    setSlidePaused(!slidePaused);
  }
  wake();
});
viewer.addEventListener("pointermove", wake);
// Swipe left/right on touch screens.
let swipeX: number | null = null;
viewer.addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "mouse") swipeX = e.clientX;
});
viewer.addEventListener("pointerup", (e) => {
  if (swipeX == null) return;
  const dx = e.clientX - swipeX;
  swipeX = null;
  if (Math.abs(dx) > 50) stepViewer(dx < 0 ? 1 : -1);
});

// ---- About ----

// The owner's note: plain text from the admin, built from text nodes (never HTML). Blank lines start a
// paragraph, single line breaks stay, and email addresses and web links become links.
const LINK_RE = /(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g;
function linkify(line: string) {
  const parts: (string | HTMLElement)[] = [];
  let last = 0;
  for (const m of line.matchAll(LINK_RE)) {
    parts.push(line.slice(last, m.index));
    const url = m[0];
    const email = !url.startsWith("http");
    parts.push(el("a", { href: email ? `mailto:${url}` : url, text: url, ...(email ? {} : { target: "_blank", rel: "noopener" }) }));
    last = m.index + url.length;
  }
  parts.push(line.slice(last));
  return parts;
}
function renderAboutOwner(text: string) {
  const box = $("about-owner");
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  box.replaceChildren(
    ...paragraphs.map((p) => {
      const para = el("p");
      p.split("\n").forEach((line, i) => {
        if (i) para.append(el("br"));
        para.append(...linkify(line));
      });
      return para;
    }),
  );
  box.hidden = !paragraphs.length;
}

// Light / dark: dark unless the visitor chose light, whatever the system setting. The choice is remembered
// per browser; index.html applies it before the page draws.
const THEME_KEY = "pan.theme";
const themeToggle = $("theme-toggle");
function showTheme() {
  const label = document.documentElement.dataset.theme === "light" ? "Switch to dark mode" : "Switch to light mode";
  themeToggle.setAttribute("aria-label", label);
  themeToggle.title = label;
}
themeToggle.addEventListener("click", () => {
  const light = document.documentElement.dataset.theme !== "light";
  if (light) document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  try {
    localStorage.setItem(THEME_KEY, light ? "light" : "dark");
  } catch {
    // storage unavailable; the choice lasts for this visit only
  }
  showTheme();
});
showTheme();

const about = $<HTMLDialogElement>("about");
$("about-open").addEventListener("click", () => {
  about.showModal();
  about.scrollTop = 0;
});
$("about-close").addEventListener("click", () => about.close());
// A click outside the box (on the backdrop) closes it; the box has padding, so check the position.
about.addEventListener("click", (e) => {
  if (e.target !== about) return;
  const r = about.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) about.close();
});

window.addEventListener("popstate", () => {
  query = new URLSearchParams(location.search);
  void load();
});

// Everything the gallery shows comes from one file, loaded once.
const siteData = await api<SiteData>("data.json").catch((err): SiteData => {
  showError(`Couldn't load photos: ${(err as Error).message}`);
  return { settings: { ...DEFAULT_SETTINGS }, attributes: [], photos: [] };
});
settings = siteData.settings;
// The admin runs only on the owner's computer, so the exported site has no link to it.
if (import.meta.env.MODE === "site") $("admin-link").remove();
const gallery = createGallery(siteData.photos, siteData.attributes);
document.title = settings.siteTitle;
// The code is MIT-licensed; the photos aren't.
$("copyright").textContent = `Photos © ${settings.siteTitle}. All rights reserved.`;
document.querySelector(".brand")!.textContent = settings.siteTitle;
$("about-title").textContent = `About ${settings.siteTitle}`;
renderAboutOwner(settings.aboutText);
const allDefs = siteData.attributes;
const shownDef = (d: AttributeDef) => !d.adminOnly;
defs = allDefs.filter(shownDef);
// Drop filters and sorts on admin-only tags (such as main_hue): the filtering ignores them too, and they
// would otherwise linger in the address.
{
  const hidden = new Set(allDefs.filter((d) => !shownDef(d)).map((d) => d.id));
  const q = new URLSearchParams(location.search);
  const stale = [...q.keys()].filter((k) => hidden.has(k));
  if (hidden.has(q.get("sort") ?? "")) stale.push("sort", "order");
  if (stale.length) {
    for (const k of stale) q.delete(k);
    history.replaceState(null, "", `${location.pathname}${q.size ? `?${q}` : ""}`);
    query = q; // the page's own copy too, or the next change would write them back
  }
}
buildSort();
buildSliders();
buildPrimary();
buildPresence();
for (const group of ["activity", "sky", "colour"] as const) buildTagChips(group);
buildMap3D();
buildSections();
// A shared photo link (?photo=<id>): take it out of the address, so filters work as usual, then open
// that photo's details once the gallery has loaded. Unpublished or deleted photos just show the gallery.
const linkedPhoto = query.get("photo");
if (linkedPhoto) {
  query.delete("photo");
  history.replaceState(null, "", query.size ? `?${query}` : location.pathname);
}
load();
if (linkedPhoto) {
  const i = photos.findIndex((p) => p.id === linkedPhoto);
  if (i >= 0) openLightbox(i);
}
