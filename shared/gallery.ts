import type { AttributeDef, ColourPoint, MapPoint, PhotoListResponse, PublicPhoto } from "./types.ts";

// The gallery's filtering, counts, sorting, colour picker and 3D map. Pure: it runs in the browser over the
// photos in data.json (the static site), given the attribute definitions that came with them.

export const isNumericKind = (kind: AttributeDef["kind"]) => kind === "percent" || kind === "scale";

// Numeric attributes filter on an inclusive range ("70-100") or on "present" (coverage judged present);
// multi attributes (the palette) on any of a comma-separated list of values ("red,blue"), optionally only
// against a photo's first value (?palette_primary=1, its primary colour); the others on an exact value. The colour picker's "hue" filter
// is a range on the colour axis (see colourPos), by the main colour.
type Filter =
  | { kind: "eq"; value: string }
  | { kind: "includes"; values: string[]; primaryOnly: boolean }
  | { kind: "present" }
  | { kind: "range"; min: number; max: number }
  | { kind: "hue"; min: number; max: number };
export type Filters = Record<string, Filter>;

const RANGE = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/;

export function parseFilters(defs: AttributeDef[], query: URLSearchParams): Filters {
  const filters: Filters = {};
  const hue = RANGE.exec(query.get("hue") ?? "");
  if (hue) {
    const min = Math.max(0, Number(hue[1]));
    const max = Math.min(100, Number(hue[2]));
    if (min > 0 || max < 100) filters.hue = { kind: "hue", min, max };
  }
  // Hidden (admin-only) tags have no control in the gallery, so a filter on one couldn't be seen or cleared.
  for (const def of defs.filter((d) => !d.adminOnly)) {
    const value = query.get(def.id);
    if (!value) continue;
    if (isNumericKind(def.kind)) {
      if (value === "present" && def.kind === "percent") {
        filters[def.id] = { kind: "present" };
        continue;
      }
      const m = RANGE.exec(value);
      if (!m) continue;
      const min = Math.max(0, Number(m[1]));
      const max = Math.min(100, Number(m[2]));
      if (min > 0 || max < 100) filters[def.id] = { kind: "range", min, max };
    } else {
      filters[def.id] = def.kind === "multi" ? { kind: "includes", values: value.split(",").filter(Boolean), primaryOnly: query.get(`${def.id}_primary`) === "1" } : { kind: "eq", value };
    }
  }
  // "Primary only" with no values selected still applies to the counts (see query below).
  for (const def of defs.filter((d) => d.kind === "multi" && !d.adminOnly))
    if (!filters[def.id] && query.get(`${def.id}_primary`) === "1") filters[def.id] = { kind: "includes", values: [], primaryOnly: true };
  return filters;
}

// A photo without a value (unknown or not applicable) never matches an active filter.
function matchesOne(p: PublicPhoto, attr: string, f: Filter) {
  if (f.kind === "present") return p.contains.includes(attr);
  if (f.kind === "hue") {
    const x = colourPos(p);
    return x != null && x >= f.min && x <= f.max;
  }
  const v = p.attrs[attr];
  if (v == null) return false;
  if (f.kind === "eq") return v === f.value;
  if (f.kind === "includes") {
    if (!f.values.length) return true;
    const own = v.split(",");
    return (f.primaryOnly ? own.slice(0, 1) : own).some((x) => f.values.includes(x));
  }
  const n = Number(v);
  return n >= f.min && n <= f.max;
}

const matches = (p: PublicPhoto, filters: Filters, ...except: string[]) =>
  Object.entries(filters).every(([attr, f]) => except.includes(attr) || matchesOne(p, attr, f));

// ---- Map view ----
// One cube, each axis 0–100: water → mountains (x), main colour (y, stretched; see colourStretch) and scale,
// macro → vista (z). A pointer (m3=x,y,z,r) grows into a sphere; only the photos inside it pass, like any
// other filter.

export interface MapPointer {
  x: number;
  y: number;
  z: number;
  r: number;
}
export type MapQuery = MapPointer | null;
export const MAP_MAX_RADIUS = 174; // covers the whole cube from any point (√3 × 100)

// The map is an ordinary filter in the Sliders view: off (null) until a pointer is placed (m3).
export function parseMap(query: URLSearchParams): MapQuery {
  const m = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?),(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(query.get("m3") ?? "");
  if (!m) return null;
  const clamp = (n: number, max: number) => Math.max(0, Math.min(max, n));
  return { x: clamp(Number(m[1]), 100), y: clamp(Number(m[2]), 100), z: clamp(Number(m[3]), 100), r: clamp(Number(m[4]), MAP_MAX_RADIUS) };
}

// Water → mountains: three places, matching the primary-subject groups: water (with shores and
// waterfalls) 0, foothills (everything in between: meadows, forests, flowers and small plants, desert) 50,
// mountains (with rock) 100.
// Sky isn't counted: nearly every photo has some, and it pulled everything toward one end. A photo sits at
// the average of the places, weighted by the shares of the categories judged present there (60% foothills
// and 40% mountains → 70). Photos with no ground category (only sky) aren't placed.
const WATER_TO_MOUNTAINS: Record<string, number> = {
  cover_water: 0,
  cover_waterfall: 0,
  cover_shore: 0,
  cover_meadow: 50,
  cover_plants: 50,
  cover_desert: 50,
  cover_forest: 50,
  cover_mountains: 100,
  cover_rock: 100,
};
// Snow and autumn foliage cover other things rather than being places of their own, so their share goes
// to what they cover: the largest other category present (snowy trees → foothills, a glacier → mountains).
// With nothing else present, they sit at their fallback position.
const COVERINGS: { id: string; fallback: number; prefer?: string }[] = [
  { id: "cover_snow", fallback: 100 },
  { id: "cover_autumn", fallback: 50, prefer: "cover_forest" },
];
function waterToMountains(p: PublicPhoto) {
  const share = (id: string) => Number(p.attrs[id] ?? 0);
  const present = Object.entries(WATER_TO_MOUNTAINS)
    .filter(([id]) => p.contains.includes(id))
    .map(([id, pos]) => ({ id, pos, share: share(id) }))
    .sort((x, y) => y.share - x.share);
  let sum = 0;
  let weight = 0;
  for (const c of present) {
    sum += c.pos * c.share;
    weight += c.share;
  }
  for (const c of COVERINGS) {
    if (!p.contains.includes(c.id)) continue;
    const target = present.find((r) => r.id === c.prefer) ?? present[0];
    sum += (target ? target.pos : c.fallback) * share(c.id);
    weight += share(c.id);
  }
  if (!present.length && !weight) return null;
  return weight > 0 ? sum / weight : present[0]!.pos;
}

// The colour axis (the colour picker and the cube): photos with a main colour fill 12–100 by its hue;
// barely colourful ones sit in a neutral band at 5. main_hue is admin-only as a tag, but its value is
// still in attrs for this.
const NEUTRAL_POS = 5;
function colourPos(p: PublicPhoto) {
  if (p.attrs.main_hue != null) return 12 + Number(p.attrs.main_hue) * 0.88;
  return p.attrs.saturation != null ? NEUTRAL_POS : null; // measured but no clear colour, or not measured
}

// The cube's colour axis is stretched where photos are crowded: hued photos (12–100) are placed by their
// rank among all published photos' colours, so blue skies and orange light don't pile up in thin bands.
// Colours keep their order; the neutral band (5) stays. `axis` samples the stretch, cube position → colour
// position, so the page can name colours and draw the strip to match.
function colourStretch(list: PublicPhoto[]) {
  const vals = list.map(colourPos).filter((v): v is number => v != null && v >= 12).sort((a, b) => a - b);
  const n = vals.length;
  const below = (v: number, orEqual: boolean) => {
    let lo = 0, hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (orEqual ? vals[mid]! <= v : vals[mid]! < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  // Ties share the middle of their ranks.
  const toY = (v: number) => (v < 12 || !n ? v : 12 + (88 * (below(v, false) + below(v, true))) / 2 / n);
  const quantile = (q: number) => {
    if (!n) return 12 + 88 * q;
    const i = q * (n - 1);
    return vals[Math.floor(i)]! + (vals[Math.ceil(i)]! - vals[Math.floor(i)]!) * (i - Math.floor(i));
  };
  const axis: [number, number][] = [];
  for (let y = 12; y <= 100; y += 2) axis.push([y, Math.round(quantile((y - 12) / 88) * 10) / 10]);
  return { toY, axis };
}

function mapCoords(p: PublicPhoto, toY: (v: number) => number): [number, number, number] | null {
  const x = waterToMountains(p);
  const y = colourPos(p);
  if (x == null || y == null || p.attrs.scale == null) return null;
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return [r1(x), r1(toY(y)), Number(p.attrs.scale)];
}

// The photos inside the sphere. Photos the cube can't place (no ground category, such as sky-only ones)
// pass only when the sphere covers everything.
function inSphere(c: [number, number, number] | null, m: NonNullable<MapQuery>) {
  if (m.r >= MAP_MAX_RADIUS) return true;
  return c != null && Math.hypot(c[0] - m.x, c[1] - m.y, c[2] - m.z) <= m.r;
}

// A random order that stays the same for a seed: each photo is ranked by a hash of the seed and its id,
// so filtering keeps the remaining photos in the same relative order.
function seededRank(seed: string, id: string) {
  let h = 2166136261;
  for (const ch of `${seed}:${id}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  // Final mix (MurmurHash3's), so seeds that differ in one character give unrelated orders.
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// The data never changes while the page is open, so the colour stretch and each photo's place in the cube
// are computed once. Fine for a personal gallery (thousands of photos): each query is an in-memory pass
// over the list.
export function createGallery(all: PublicPhoto[], defs: AttributeDef[]) {
  const stretch = colourStretch(all);
  const coords = new Map(all.map((p) => [p, mapCoords(p, stretch.toY)]));
  const sortable = new Set(defs.filter((a) => isNumericKind(a.kind)).map((a) => a.id));

  // Filters, the map pointer (m3), sort, order and seed, as in the page's address. Always includes the
  // colour picker's and the 3D map's dots.
  function query(params: URLSearchParams): PhotoListResponse {
    const filters = parseFilters(defs, params);
    const map = parseMap(params);
    const sort = params.get("sort") ?? undefined;
    const order = params.get("order") ?? undefined;
    const seed = params.get("seed") ?? "";
    // The map's sphere applies with every other filter, so counts reflect it too.
    const pick = (list: PublicPhoto[]) => (map ? list.filter((p) => inSphere(coords.get(p)!, map)) : list);

    const facets: PhotoListResponse["facets"] = {};
    const histograms: PhotoListResponse["histograms"] = {};
    for (const def of defs) {
      const counts: Record<string, number> = {};
      const numeric = isNumericKind(def.kind);
      const buckets = numeric ? Array<number>(10).fill(0) : null;
      for (const p of pick(all.filter((x) => matches(x, filters, def.id)))) {
        const v = p.attrs[def.id];
        if (v == null) continue;
        if (buckets) {
          buckets[Math.min(9, Math.floor(Number(v) / 10))]!++;
          if (p.contains.includes(def.id)) counts.present = (counts.present ?? 0) + 1;
        } else {
          const f = filters[def.id];
          const own = def.kind === "multi" ? v.split(",") : [v];
          for (const x of f?.kind === "includes" && f.primaryOnly ? own.slice(0, 1) : own) counts[x] = (counts[x] ?? 0) + 1;
        }
      }
      facets[def.id] = counts;
      if (buckets) histograms[def.id] = buckets;
    }

    const candidates = all.filter((p) => matches(p, filters));
    const photos = pick(candidates);
    if (sort && sortable.has(sort)) {
      const dir = order === "asc" ? 1 : -1;
      const val = (p: PublicPhoto) => Number(p.attrs[sort] ?? (dir > 0 ? Infinity : -Infinity));
      photos.sort((a, b) => dir * (val(a) - val(b))); // stable, so ties stay newest first
    } else if (sort === "number") {
      photos.sort((a, b) => a.number - b.number); // Image 1 first
    } else if (sort !== "newest") {
      // Random, the default (no sort, or sort=random).
      photos.sort((a, b) => seededRank(seed, a.id) - seededRank(seed, b.id));
    } else {
      // Newest first: by the date taken (EXIF); photos without one follow, most recently uploaded first
      // (the order they arrive in). The ISO-style strings sort as dates.
      photos.sort((a, b) => (a.takenAt && b.takenAt ? b.takenAt.localeCompare(a.takenAt) : a.takenAt ? -1 : b.takenAt ? 1 : 0));
    }

    // The map's dots: every photo the other filters allow; with a pointer placed, those inside are marked.
    const inMap = map ? new Set(photos.map((p) => p.id)) : new Set<string>();
    const mapPoints: MapPoint[] = [];
    for (const p of candidates) {
      const c = coords.get(p)!;
      if (c) mapPoints.push({ id: p.id, title: p.title ?? p.name, thumbUrl: p.thumbUrl, pos: c, match: inMap.has(p.id) });
    }

    // Colour picker: every photo the other filters allow (not its own hue and saturation), so the square
    // shows where a box could go; the photos inside the current box are marked.
    const chosen = new Set(photos.map((p) => p.id));
    const colourPoints: ColourPoint[] = [];
    for (const p of all) {
      if (!matches(p, filters, "hue", "saturation")) continue;
      const x = colourPos(p);
      if (x == null || p.attrs.saturation == null) continue;
      colourPoints.push({ id: p.id, title: p.title ?? p.name, thumbUrl: p.thumbUrl, x: Math.round(x * 10) / 10, y: Number(p.attrs.saturation), match: chosen.has(p.id) });
    }

    return { photos, total: all.length, facets, histograms, mapPoints, colourAxis: stretch.axis, colourPoints };
  }

  return { query };
}
