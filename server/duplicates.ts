import type { DuplicateGroup, DuplicateReport } from "../shared/types.ts";
import { allFingerprints, dataVersion, dismissedPairs, listPhotos, type PhotoRow } from "./db.ts";
import { FINGERPRINT_GRID, type Fingerprint } from "./storage.ts";

// Possible duplicates among the visible photos (hiding a copy resolves it), from their fingerprints
// (storage.ts). Two ways in:
// - Ordinary frames: a pair is a candidate when taken close together or when their dHashes are close, and is
//   flagged when one matches the other turned by up to MAX_ANGLE° and zoomed (a straightened copy is cropped).
// - Panoramas: pairs taken the same day or without a time are candidates (their stitches may differ in
//   crop, width and capture time), and are flagged when the narrower field of view is found inside the other.
// Pair scores are Pearson correlations of greyscale pixels (so exposure edits don't matter), cached per
// fingerprint, so only new photos are compared after the first run.

const TIME_WINDOW_S = 120; // taken this close together → compare
const DHASH_MAX = 12; // or dHashes this close (of 64 bits) → compare
const ASPECT_TOLERANCE = 0.2; // ordinary frames must have about the same shape
const MAX_ANGLE = 5; // degrees of straightening allowed for
// Scores of 0.6+ were the same scene from the same spot in the owner's album; unrelated frames taken
// minutes apart mostly scored under 0.3. Without nearby capture times, only the look connects two photos,
// so it must be closer.
const NEARBY_SIMILAR_MIN = 0.6;
const SIMILAR_MIN = 0.8;
const PANORAMA_ASPECT = 1.8; // long side / short side
const PANORAMA_WINDOW_S = 24 * 3600; // panoramas taken this close together, or without a time → compare
const PROFILE_MIN = 0.7; // panoramas: column-detail profiles this alike → look closely
const PANORAMA_SIMILAR_MIN = 0.75; // unrelated panoramas scored up to ~0.55; re-crops of one 0.78+

interface Photo {
  id: string;
  seq: number;
  time: number | null; // seconds; camera local time read as UTC (only differences matter)
  aspect: number; // width / height
  panorama: boolean;
  dhash: [number, number];
  grid: Float32Array; // detail only (see highPass)
  strip: Strip; // long side across
  key: string; // changes when the fingerprint does
}

interface Strip {
  px: Float32Array; // detail only (see highPass)
  w: number;
  h: number;
  profile: Float64Array; // how much detail each PROFILE_STEP columns have
}

// ---- Report (cached per database version) ----

let cached: { version: string; report: DuplicateReport } | null = null;

export function duplicateReport(): DuplicateReport {
  const version = dataVersion();
  if (cached?.version !== version) cached = { version, report: buildReport() };
  return cached.report;
}

function buildReport(): DuplicateReport {
  const prints = allFingerprints();
  const rows = listPhotos({ publicOnly: false }).filter((r) => r.published && r.derived_ready);
  const photos: Photo[] = [];
  let unfingerprinted = 0;
  for (const r of rows) {
    const f = prints.get(r.id);
    if (!f || !r.width || !r.height) unfingerprinted++;
    else photos.push(toPhoto(r, f));
  }

  const dismissed = dismissedPairs();
  const flagged: { a: Photo; b: Photo; score: number }[] = [];
  for (const c of candidatePairs(photos)) {
    const { a, b } = c;
    if (dismissed.has(a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`)) continue;
    const score = Math.max(c.frame ? cachedScore("frame", a, b) : -1, c.panorama ? cachedScore("panorama", a, b) : -1);
    const min = closeInTime(a, b) ? NEARBY_SIMILAR_MIN : a.panorama && b.panorama ? PANORAMA_SIMILAR_MIN : SIMILAR_MIN;
    if (score >= min) flagged.push({ a, b, score });
  }
  return { groups: group(flagged), unfingerprinted };
}

function toPhoto(r: PhotoRow, f: Fingerprint): Photo {
  const aspect = r.width! / r.height!;
  return {
    id: r.id,
    seq: r.seq,
    time: r.taken_at ? Date.parse(`${r.taken_at}Z`) / 1000 : null,
    aspect,
    panorama: Math.max(aspect, 1 / aspect) >= PANORAMA_ASPECT,
    dhash: [parseInt(f.dhash.slice(0, 8), 16), parseInt(f.dhash.slice(8), 16)],
    grid: highPass(f.grid, FINGERPRINT_GRID, FINGERPRINT_GRID, GRID_BLUR),
    strip: toStrip(f.strip, f.stripWidth, f.stripHeight),
    key: `${r.id}:${f.dhash}`,
  };
}

// Tall panoramas are turned on their side, so strips always run across.
function toStrip(src: Uint8Array, w: number, h: number): Strip {
  let raw = src;
  if (h > w) {
    raw = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[x * h + y] = src[y * w + x]!;
    [w, h] = [h, w];
  }
  const px = highPass(raw, w, h, STRIP_BLUR);
  const profile = new Float64Array(Math.floor(w / PROFILE_STEP));
  for (let x = 0; x < profile.length * PROFILE_STEP; x++) {
    for (let y = 0; y < h; y++) profile[Math.floor(x / PROFILE_STEP)]! += Math.abs(px[y * w + x]!);
  }
  return { px, w, h, profile };
}

// Each pixel minus the mean of the (2r+1)² square around it. Broad light (a bright sky over darker
// ground) is in nearly every landscape, so comparing whole pixels finds unrelated photos alike; the
// detail that's left (edges, texture, shapes) is what makes a scene itself.
const GRID_BLUR = 4;
const STRIP_BLUR = 3;
function highPass(px: Uint8Array, w: number, h: number, r: number) {
  const sum = new Float64Array((w + 1) * (h + 1)); // summed-area table
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += px[y * w + x]!;
      sum[(y + 1) * (w + 1) + x + 1] = sum[y * (w + 1) + x + 1]! + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const total = sum[y1 * (w + 1) + x1]! - sum[y0 * (w + 1) + x1]! - sum[y1 * (w + 1) + x0]! + sum[y0 * (w + 1) + x0]!;
      out[y * w + x] = px[y * w + x]! - total / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

// Unions flagged pairs into groups, ordered by capture time (then image number) within and between groups.
function group(flagged: { a: Photo; b: Photo; score: number }[]): DuplicateGroup[] {
  const parent = new Map<Photo, Photo>();
  const find = (p: Photo): Photo => {
    const up = parent.get(p) ?? p;
    if (up === p) return p;
    const root = find(up);
    parent.set(p, root);
    return root;
  };
  for (const { a, b } of flagged) parent.set(find(a), find(b));

  const groups = new Map<Photo, { members: Set<Photo>; similarity: number; panorama: boolean }>();
  for (const { a, b, score } of flagged) {
    const root = find(a);
    const g = groups.get(root) ?? { members: new Set(), similarity: 0, panorama: false };
    g.members.add(a).add(b);
    g.similarity = Math.max(g.similarity, score);
    g.panorama ||= a.panorama && b.panorama;
    groups.set(root, g);
  }
  const order = (p: Photo) => [p.time ?? Infinity, p.seq] as const;
  const byOrder = (x: Photo, y: Photo) => order(x)[0] - order(y)[0] || x.seq - y.seq;
  return [...groups.values()]
    .map((g) => {
      const members = [...g.members].sort(byOrder);
      const times = members.map((p) => p.time).filter((t) => t != null);
      return {
        members,
        ids: members.map((p) => p.id),
        similarity: Math.round(g.similarity * 1000) / 1000,
        spanSeconds: times.length === members.length ? Math.max(...times) - Math.min(...times) : null,
        panorama: g.panorama,
      };
    })
    .sort((x, y) => byOrder(x.members[0]!, y.members[0]!))
    .map(({ members: _, ...g }) => g);
}

// ---- Candidates ----

interface Candidate {
  a: Photo;
  b: Photo;
  frame: boolean; // compare as ordinary frames (taken close together, or alike at a glance)
  panorama: boolean; // compare as panorama versions
}

function candidatePairs(photos: Photo[]): Candidate[] {
  const pairs = new Map<string, Candidate>();
  const add = (a: Photo, b: Photo, kind: "frame" | "panorama") => {
    const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    const c = pairs.get(key) ?? { a, b, frame: false, panorama: false };
    c[kind] = true;
    pairs.set(key, c);
  };

  // Taken close together.
  const timed = photos.filter((p) => p.time != null).sort((a, b) => a.time! - b.time!);
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length && timed[j]!.time! - timed[i]!.time! <= TIME_WINDOW_S; j++) add(timed[i]!, timed[j]!, "frame");
  }
  // Look alike at a glance, whenever taken.
  for (let i = 0; i < photos.length; i++) {
    const a = photos[i]!;
    for (let j = i + 1; j < photos.length; j++) {
      const b = photos[j]!;
      if (popcount(a.dhash[0] ^ b.dhash[0]) + popcount(a.dhash[1] ^ b.dhash[1]) <= DHASH_MAX) add(a, b, "frame");
    }
  }
  // Panoramas taken the same day, or without a time. A re-stitch keeps a source frame's time (one of
  // the first or last) or loses it.
  const panoramas = photos.filter((p) => p.panorama);
  for (let i = 0; i < panoramas.length; i++) {
    for (let j = i + 1; j < panoramas.length; j++) {
      const a = panoramas[i]!, b = panoramas[j]!;
      const sameDay = a.time == null || b.time == null || Math.abs(a.time - b.time) <= PANORAMA_WINDOW_S;
      if (sameDay && a.aspect >= 1 === b.aspect >= 1) add(a, b, "panorama");
    }
  }
  return [...pairs.values()];
}

const closeInTime = (a: Photo, b: Photo) => a.time != null && b.time != null && Math.abs(a.time - b.time) <= TIME_WINDOW_S;

function popcount(n: number) {
  n -= (n >>> 1) & 0x55555555;
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// ---- Scoring ----

const scores = new Map<string, number>();

function cachedScore(kind: "frame" | "panorama", a: Photo, b: Photo) {
  const key = `${kind} ${a.key < b.key ? `${a.key}|${b.key}` : `${b.key}|${a.key}`}`;
  let score = scores.get(key);
  if (score == null) {
    score = kind === "frame" ? frameScore(a, b) : panoramaScore(a.strip, b.strip);
    scores.set(key, score);
  }
  return score;
}

// Pearson correlation, accumulated one pair of samples at a time.
class Correlation {
  n = 0;
  sx = 0;
  sy = 0;
  sxx = 0;
  syy = 0;
  sxy = 0;
  add(x: number, y: number) {
    this.n++;
    this.sx += x;
    this.sy += y;
    this.sxx += x * x;
    this.syy += y * y;
    this.sxy += x * y;
  }
  value() {
    const vx = this.n * this.sxx - this.sx * this.sx;
    const vy = this.n * this.syy - this.sy * this.sy;
    return vx <= 0 || vy <= 0 ? -1 : (this.n * this.sxy - this.sx * this.sy) / Math.sqrt(vx * vy);
  }
}

// Bilinear sample of a w×h image; null outside it.
function sample(px: Float32Array, w: number, h: number, x: number, y: number) {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return null;
  const x0 = Math.min(Math.floor(x), w - 2), y0 = Math.min(Math.floor(y), h - 2);
  const fx = x - x0, fy = y - y0;
  const i = y0 * w + x0;
  const top = px[i]! + (px[i + 1]! - px[i]!) * fx;
  const bottom = px[i + w]! + (px[i + w + 1]! - px[i + w]!) * fx;
  return top + (bottom - top) * fy;
}

// Ordinary frames: the centre of A against B moved into the pose that matches best. What can differ
// depends on how the two came about:
// - an edited copy (same second, or no capture time): turned by up to MAX_ANGLE° and zoomed up to 15%,
//   as straightening a horizon crops the frame;
// - a burst (seconds apart): shifted by up to MAX_SHIFT of the frame, zoomed a little and turned up to 1°.
// A coarse search over the poses, then a finer one around the best. Angles are in real proportions,
// though the grids are square.
const MAX_SHIFT = 0.12;
const COARSE_POINTS = 12; // samples per side, over the central 60%
const FINE_POINTS = 24;
const range = (from: number, to: number, step: number) => Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => from + i * step);
interface Pose {
  deg: number;
  s: number; // B zoomed in by
  dx: number; // B shifted, as a share of its width
  dy: number;
}
// Straightening a 3:2 frame by 5° and cropping to fill zooms it by about 1.13.
const COPY_POSES = poses(range(-MAX_ANGLE, MAX_ANGLE, 1), [1 / 1.15, 1 / 1.1, 1 / 1.05, 1, 1.05, 1.1, 1.15], [0]);
const BURST_POSES = poses([0], [1 / 1.05, 1, 1.05], range(-MAX_SHIFT, MAX_SHIFT, 0.04));
const COPY_REFINE = poses([-0.5, 0, 0.5], [-0.025, 0, 0.025], [-0.02, 0, 0.02]); // offsets from the coarse best
const BURST_REFINE = poses([-1, -0.5, 0, 0.5, 1], [-0.025, 0, 0.025], [-0.02, 0, 0.02]);
function poses(degs: number[], scales: number[], shifts: number[]) {
  return degs.flatMap((deg) => scales.flatMap((s) => shifts.flatMap((dx) => shifts.map((dy) => ({ deg, s, dx, dy })))));
}

function frameScore(a: Photo, b: Photo) {
  if (Math.abs(a.aspect / b.aspect - 1) > ASPECT_TOLERANCE) return -1;
  const burst = a.time != null && b.time != null && Math.abs(a.time - b.time) > 1;
  const aspect = (a.aspect + b.aspect) / 2;
  const coarse = framePoints(a, COARSE_POINTS);
  let best = { pose: { deg: 0, s: 1, dx: 0, dy: 0 }, score: -1 };
  for (const pose of burst ? BURST_POSES : COPY_POSES) {
    const score = poseScore(coarse, b, aspect, pose);
    if (score > best.score) best = { pose, score };
  }
  const fine = framePoints(a, FINE_POINTS);
  let score = -1;
  for (const r of burst ? BURST_REFINE : COPY_REFINE) {
    const p = best.pose;
    score = Math.max(score, poseScore(fine, b, aspect, { deg: p.deg + r.deg, s: p.s + r.s, dx: p.dx + r.dx, dy: p.dy + r.dy }));
  }
  return score;
}

const toGridPx = (u: number) => (u + 0.5) * FINGERPRINT_GRID - 0.5;

// n×n points over the central 60% of A, flattened as u, v, value (u and v from -0.5 to 0.5 across the frame).
function framePoints(a: Photo, n: number) {
  const points = new Float64Array(n * n * 3);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const u = -0.3 + (0.6 * (j + 0.5)) / n, v = -0.3 + (0.6 * (i + 0.5)) / n;
      points.set([u, v, sample(a.grid, FINGERPRINT_GRID, FINGERPRINT_GRID, toGridPx(u), toGridPx(v))!], (i * n + j) * 3);
    }
  }
  return points;
}

// The hot loop (millions of samples on a first run), so the transform and the correlation are inline.
function poseScore(points: Float64Array, b: Photo, aspect: number, { deg, s, dx, dy }: Pose) {
  const G = FINGERPRINT_GRID, grid = b.grid;
  const cos = Math.cos((deg * Math.PI) / 180), sin = Math.sin((deg * Math.PI) / 180);
  // u, v → B's grid pixels: x = ax·u + bx·v + cx, y = ay·u + by·v + cy.
  const ax = s * cos * G, bx = (-s * sin * G) / aspect, cx = (dx + 0.5) * G - 0.5;
  const ay = s * sin * aspect * G, by = s * cos * G, cy = (dy + 0.5) * G - 0.5;
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let k = 0; k < points.length; k += 3) {
    const u = points[k]!, v = points[k + 1]!;
    const x = ax * u + bx * v + cx, y = ay * u + by * v + cy;
    if (x < 0 || y < 0 || x >= G - 1 || y >= G - 1) continue;
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * G + x0;
    const top = grid[i]! + (grid[i + 1]! - grid[i]!) * fx;
    const value = top + (grid[i + G]! + (grid[i + G + 1]! - grid[i + G]!) * fx - top) * fy;
    const a = points[k + 2]!;
    n++;
    sx += a;
    sy += value;
    sxx += a * a;
    syy += value * value;
    sxy += a * value;
  }
  if (n < (points.length / 3) * 0.8) return -1;
  const vx = n * sxx - sx * sx, vy = n * syy - sy * sy;
  return vx <= 0 || vy <= 0 ? -1 : (n * sxy - sx * sy) / Math.sqrt(vx * vy);
}

// Panoramas: each one's field of view looked for inside the other, first by column-brightness profile
// (cheap), then pixel by pixel at the best few places, adjusting zoom, position and a little rotation.
const PANORAMA_SCALES = [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1];
const MIN_OVERLAP = 0.6; // of the inner strip's columns
function panoramaScore(a: Strip, b: Strip) {
  let best = -1;
  for (const [inner, outer] of [[a, b], [b, a]] as const) {
    for (const place of bestProfilePlaces(inner, outer)) {
      if (place.score < PROFILE_MIN) break;
      best = Math.max(best, refinePlace(inner, outer, place));
    }
  }
  return best;
}

interface Place {
  s: number; // inner pixels → outer pixels
  x: number; // outer column of the inner's left edge
  y: number; // outer row of the inner's top edge
  score: number;
}

// Profiles are in PROFILE_STEP-column bins (coarse, so this test is cheap); places are in strip pixels.
const PROFILE_STEP = 2;
function bestProfilePlaces(inner: Strip, outer: Strip, keep = 3): Place[] {
  const places: Place[] = [];
  const pi = inner.profile, po = outer.profile;
  for (const s of PANORAMA_SCALES) {
    const span = pi.length * s;
    for (let x = Math.floor(-(1 - MIN_OVERLAP) * span); x <= po.length - MIN_OVERLAP * span; x++) {
      const c = new Correlation();
      for (let j = 0; j < pi.length; j++) {
        const ox = x + j * s;
        if (ox < 0 || ox > po.length - 1) continue;
        const x0 = Math.min(Math.floor(ox), po.length - 2);
        c.add(pi[j]!, po[x0]! + (po[x0 + 1]! - po[x0]!) * (ox - x0));
      }
      if (c.n >= pi.length * MIN_OVERLAP) places.push({ s, x: x * PROFILE_STEP, y: (outer.h - inner.h * s) / 2, score: c.value() });
    }
  }
  places.sort((p, q) => q.score - p.score);
  // The best few, at least a few columns apart.
  const out: Place[] = [];
  for (const p of places) {
    if (out.length >= keep) break;
    if (out.every((o) => o.s !== p.s || Math.abs(o.x - p.x) > 2 * PROFILE_STEP)) out.push(p);
  }
  return out;
}

function placeScore(inner: Strip, outer: Strip, p: Place, deg: number) {
  const cos = Math.cos((deg * Math.PI) / 180), sin = Math.sin((deg * Math.PI) / 180);
  const cx = inner.w / 2, cy = inner.h / 2;
  const ox = p.x + cx * p.s, oy = p.y + cy * p.s;
  const c = new Correlation();
  for (let i = 0; i < inner.h; i += 2) {
    for (let j = 0; j < inner.w; j += 2) {
      const dx = j - cx, dy = i - cy;
      const v = sample(outer.px, outer.w, outer.h, ox + p.s * (dx * cos - dy * sin), oy + p.s * (dx * sin + dy * cos));
      if (v != null) c.add(inner.px[i * inner.w + j]!, v);
    }
  }
  return c.n >= (inner.w * inner.h * MIN_OVERLAP) / 4 ? c.value() : -1;
}

function refinePlace(inner: Strip, outer: Strip, start: Place) {
  // Zoom, position and (for a vertical crop) height, without rotation...
  let best = { ...start, score: -1 };
  for (const s of [start.s - 0.025, start.s, start.s + 0.025]) {
    if (s <= 0 || inner.h * s > outer.h + 1) continue;
    for (let x = start.x - 2; x <= start.x + 2; x++) {
      for (let y = 0; y <= outer.h - inner.h * s; y++) {
        const p = { s, x, y, score: 0 };
        p.score = placeScore(inner, outer, p, 0);
        if (p.score > best.score) best = p;
      }
    }
  }
  // ...then a little rotation.
  let score = best.score;
  for (let deg = -2; deg <= 2; deg += 0.5) if (deg !== 0) score = Math.max(score, placeScore(inner, outer, best, deg));
  return score;
}
