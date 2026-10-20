import { APIConnectionError, APIError, image, noul, type Questions, score, TypeSafeClient } from "@typesafe-ai/sdk";
import type { ApiError, ChoiceReading, ClassifyResult, FlagReading, ScoreReading, YesNo } from "../shared/types.ts";
import type { PreparedImage } from "./imagePrep.ts";
import {
  boxQuestionId,
  buildQuestions,
  CHOICES,
  choiceQuestionId,
  COLOUR_SCALES,
  COVERS,
  coverPercent,
  coverQuestionId,
  FLAGS,
  flagQuestionId,
  LOOKS,
  lookQuestionId,
  MOODS,
  moodQuestionId,
  PRESENCE,
  QUALITY,
  QUALITY_QUESTION_ID,
} from "./questions.ts";

export const JEV_MODEL = process.env.JEV_MODEL || "jev-1.14.0"; // Box needs Jev 1.14

// A Noul is stored as yes or no only when Jev leans clearly one way; in between it is "uncertain", which
// matches neither "With" nor "Without" in the gallery. Checked against the album in docs/jev-image-capabilities.md.
export const YES_MIN = 0.7;
export const NO_MAX = 0.3;
// A coverage category counts as present ("Contains") when P(any amount) is above this.
export const CONTAINS_MIN = 0.5;
// A Score is flagged uncertain when two levels at least two steps apart each get this much probability.
const SPLIT_MIN = 0.3;

export const yesNo = (p: number, yesMin = YES_MIN): YesNo => (p >= yesMin ? "true" : p <= NO_MAX ? "false" : "uncertain");

let client: TypeSafeClient | undefined;
function getClient() {
  // Lazily created so the server can start (and report health) without a key.
  client ??= new TypeSafeClient({
    defaultModel: JEV_MODEL,
    timeout: 90_000, // per attempt; image requests with many questions take longer than text
    defaultHeaders: { "TypeSafe-Danger-Zone-Images": "true" }, // images + Box are opt-in previews
  });
  return client;
}

export function hasApiKey() {
  return Boolean(process.env.TYPESAFE_API_KEY);
}

export async function askJev(img: PreparedImage) {
  const t0 = Date.now();
  const res = await getClient().systemOne({
    model: JEV_MODEL,
    state: { photo: image(img.jpeg) },
    questions: buildQuestions(),
  });
  return { res, elapsedMs: Date.now() - t0 };
}

// Only the quality question, for scoring or re-scoring photos without re-tagging them (scripts/score-quality.ts).
export async function askQuality(img: PreparedImage) {
  const t0 = Date.now();
  const res = await getClient().systemOne({
    model: JEV_MODEL,
    state: { photo: image(img.jpeg) },
    questions: { [QUALITY_QUESTION_ID]: score(QUALITY.instructions, QUALITY.levels) },
  });
  return { reading: qualityReading(res.answers[QUALITY_QUESTION_ID]), res, elapsedMs: Date.now() - t0 };
}

// Second look for small subjects: the same yes/no questions asked of each sharper tile of the original
// in one request. Returns the highest probability per presence id.
export async function askCloseLook(tiles: Buffer[], ids: string[]) {
  const state: Record<string, ReturnType<typeof image>> = {};
  tiles.forEach((jpeg, i) => (state[`tile_${i + 1}`] = image(jpeg)));
  const questions: Questions = {};
  for (const id of ids) {
    const d = PRESENCE.find((x) => x.id === id)!;
    tiles.forEach((_, i) => {
      const ref = `\`tile_${i + 1}\``;
      questions[`${id}_t${i + 1}`] = noul(d.question.replace("`photo`", ref), { true: d.yes, false: d.no });
    });
  }
  const res = await getClient().systemOne({ model: JEV_MODEL, state, questions });
  const out: Record<string, number> = {};
  for (const id of ids) {
    out[id] = Math.max(...tiles.map((_, i) => Number(res.answers[`${id}_t${i + 1}`]?.type === "noul" ? (res.answers[`${id}_t${i + 1}`] as { noul: number }).noul : 0)));
  }
  return { pById: out, usage: res.usage };
}

type Meta = { model: string; usage: { input_tokens: number | null; output_tokens: number | null }; elapsedMs: number };

function scoreReading(id: string, probabilities: number[], score: number, confidence: number, toValue: (probs: number[], score: number, max: number) => number, coverage: boolean): ScoreReading {
  const max = Math.max(1, probabilities.length - 1);
  const order = probabilities.map((p, i) => [p, i] as const).sort((a, b) => b[0] - a[0]);
  const [first, second] = order;
  const mode = first?.[1] ?? 0;
  const uncertain = Boolean(first && second && second[0] >= SPLIT_MIN && Math.abs(first[1] - second[1]) >= 2);
  return {
    id,
    value: round1(toValue(probabilities, score, max)),
    score,
    max,
    confidence,
    probabilities,
    mode,
    uncertain,
    ...(coverage ? { pPresent: round3(1 - (probabilities[0] ?? 0)) } : {}),
  };
}

const position = (_probs: number[], s: number, max: number) => (s / max) * 100;

// Quality is 1–100 from the probability-weighted level (not the most likely one, which would bunch the
// scores into 8 values), passed through a gentle curve: round(1 + 99 × curve(score / top level)).
// The curve was fixed from this album's scores on 2026-10-20 so that about 5% of photos are Excellent:
// the median (0.61) lifts slightly to 0.63, the 95th percentile (0.7414) to where Excellent starts
// (0.9286), and the ends stay put. Piecewise linear, so it never changes the order of photos. After
// changing it, npm run remap-quality rewrites the stored values without asking Jev.
const QUALITY_CURVE: [number, number][] = [[0, 0], [0.61, 0.63], [0.7414, 0.9286], [1, 1]];
const qualityCurve = (x: number) => {
  const i = QUALITY_CURVE.findIndex(([px]) => px >= x);
  if (i <= 0) return QUALITY_CURVE[Math.max(0, i)]![1];
  const [x0, y0] = QUALITY_CURVE[i - 1]!;
  const [x1, y1] = QUALITY_CURVE[i]!;
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
};
const qualityValue = (_probs: number[], s: number, max: number) => Math.round(1 + 99 * qualityCurve(Math.min(1, Math.max(0, s / max))));

// The quality answer, or undefined when it isn't a Score answer: a missing score is unknown, never 0.
export function qualityReading(a: any): ScoreReading | undefined {
  if (a?.type !== "score") return undefined;
  const n = Math.max(2, Object.keys(a.probabilities ?? {}).length);
  const probabilities = Array.from({ length: n }, (_, i) => Number(a.probabilities?.[i] ?? 0));
  return scoreReading(QUALITY.id, probabilities, Number(a.score ?? 0), Number(a.confidence ?? 0), qualityValue, false);
}

// Panoramas: each level's probability, the score and the confidence averaged over the tiles that answered.
export function mergeQuality(parts: (ScoreReading | undefined)[]): ScoreReading | undefined {
  const got = parts.filter((q): q is ScoreReading => q != null);
  if (!got.length) return undefined;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const probs = got[0]!.probabilities.map((_, i) => mean(got.map((q) => q.probabilities[i] ?? 0)));
  return scoreReading(QUALITY.id, probs, mean(got.map((q) => q.score)), mean(got.map((q) => q.confidence)), qualityValue, false);
}

// Defensive normalization: never trust that every answer arrived with the expected type.
export function normalize(answers: Record<string, any>, img: PreparedImage, meta: Meta): ClassifyResult {
  const pick = (id: string, type: string) => (answers[id]?.type === type ? answers[id] : undefined);

  const reading = (id: string, questionId: string, toValue: typeof position, coverage = false): ScoreReading => {
    const a = pick(questionId, "score");
    const n = Math.max(2, Object.keys(a?.probabilities ?? {}).length);
    const probabilities = Array.from({ length: n }, (_, i) => Number(a?.probabilities?.[i] ?? 0));
    return scoreReading(id, probabilities, Number(a?.score ?? 0), Number(a?.confidence ?? 0), toValue, coverage);
  };
  const choiceReading = (id: string, questionId: string, fallback: string): ChoiceReading => {
    const a = pick(questionId, "choice");
    const probabilities: Record<string, number> = { ...(a?.probabilities ?? {}) };
    const value: string = a?.choice ?? Object.entries(probabilities).sort((x, y) => y[1] - x[1])[0]?.[0] ?? fallback;
    return { id, value, confidence: Number(a?.confidence ?? 0), probabilities };
  };
  const flag = (id: string, questionId: string, yesMin?: number): FlagReading => {
    const p = round3(Number(pick(questionId, "noul")?.noul ?? 0));
    return { id, p, value: yesNo(p, yesMin) };
  };

  const presence = PRESENCE.map((d) => flag(d.id, d.questionId, d.yesMin));
  const boxes: ClassifyResult["boxes"] = {};
  for (const d of PRESENCE) {
    const b = pick(boxQuestionId(d.id), "box");
    if (b?.box) boxes[d.id] = { box: { ...b.box }, confidence: b.confidence ?? null };
  }

  return {
    image: { width: img.width, height: img.height, originalFormat: img.originalFormat, resized: img.resized },
    coverage: COVERS.map((c) => reading(c.id, coverQuestionId(c.id), (probs) => coverPercent(probs), true)),
    moods: MOODS.map((m) => reading(m.id, moodQuestionId(m.id), position)),
    look: [...LOOKS, ...COLOUR_SCALES].map((l) => reading(l.id, lookQuestionId(l.id), position)),
    quality: qualityReading(answers[QUALITY_QUESTION_ID]),
    primary: choiceReading("primary_scene", "primary_scene", "other"),
    choices: CHOICES.map((c) => choiceReading(c.id, choiceQuestionId(c.id), c.options.at(-1)!.id)),
    presence,
    flags: FLAGS.map((f) => flag(f.id, flagQuestionId(f.id), f.yesMin)),
    boxes, // filtered to "true" presence tags by finalize()
    model: meta.model,
    usage: { inputTokens: meta.usage.input_tokens, outputTokens: meta.usage.output_tokens },
    elapsedMs: meta.elapsedMs,
  };
}

// Applies a close-look result to the presence tags, then drops boxes for anything not clearly present.
export function finalize(r: ClassifyResult, closeLook?: Record<string, number>): ClassifyResult {
  const presence = r.presence.map((d) => {
    const def = PRESENCE.find((x) => x.id === d.id);
    const closeLookP = def?.closeLook === false ? undefined : closeLook?.[d.id];
    return closeLookP == null ? d : { ...d, closeLookP: round3(closeLookP), value: yesNo(closeLookP, def?.closeLookYesMin ?? def?.yesMin) };
  });
  const yes = new Set(presence.filter((d) => d.value === "true").map((d) => d.id));
  const boxes = Object.fromEntries(Object.entries(r.boxes ?? {}).filter(([id]) => yes.has(id)));
  return { ...r, presence, boxes };
}

// Combines the answers for the tiles of a panorama: coverage from the averaged level probabilities (with
// "present" if any tile has it), quality averaged over the tiles, yes/no tags from the most confident tile,
// everything else from the centre.
export function mergeTiles(parts: ClassifyResult[]): ClassifyResult {
  const centre = parts[Math.floor(parts.length / 2)]!;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const coverage = centre.coverage.map((c, k) => {
    const probs = c.probabilities.map((_, i) => mean(parts.map((p) => p.coverage[k]!.probabilities[i] ?? 0)));
    const r = scoreReading(c.id, probs, mean(parts.map((p) => p.coverage[k]!.score)), mean(parts.map((p) => p.coverage[k]!.confidence)), (pr) => coverPercent(pr), true);
    return { ...r, pPresent: Math.max(...parts.map((p) => p.coverage[k]!.pPresent ?? 0)) };
  });
  const maxFlag = (pick: (p: ClassifyResult) => FlagReading[]) =>
    pick(centre).map((f, k) => {
      const p = Math.max(...parts.map((x) => pick(x)[k]!.p));
      return { ...f, p, value: yesNo(p, [...FLAGS, ...PRESENCE].find((d) => d.id === f.id)?.yesMin) };
    });
  return {
    ...centre,
    image: { ...centre.image, tiles: parts.length },
    coverage,
    quality: mergeQuality(parts.map((p) => p.quality)),
    presence: maxFlag((p) => p.presence),
    flags: maxFlag((p) => p.flags),
    boxes: {}, // a box on one tile doesn't map onto the whole panorama
    usage: {
      inputTokens: parts.reduce((a, p) => a + (p.usage.inputTokens ?? 0), 0),
      outputTokens: parts.reduce((a, p) => a + (p.usage.outputTokens ?? 0), 0),
    },
    elapsedMs: parts.reduce((a, p) => a + p.elapsedMs, 0),
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export interface JevAttribute {
  attr: string;
  value: string;
  confidence: number | null;
  detail?: object | null;
}

const scoreDetail = (r: ScoreReading) => ({
  probabilities: r.probabilities.map(round3),
  mode: r.mode,
  ...(r.pPresent != null ? { pPresent: r.pPresent } : {}),
  ...(r.uncertain ? { uncertain: true } : {}),
});
const flagDetail = (f: FlagReading) => ({ p: f.p, ...(f.closeLookP != null ? { closeLookP: f.closeLookP } : {}) });
// Concentration of a yes/no answer (0 = coin flip, 1 = certain either way), the measure TypeSafe suggests.
const flagConfidence = (f: FlagReading) => round3(Math.abs(2 * (f.closeLookP ?? f.p) - 1));

// Re-applies the current presence rules (thresholds, which tags get a close look) to a stored result,
// from its saved probabilities. Used by scripts/derive-tags.ts; no Jev call.
export function reapplyPresence(r: ClassifyResult): ClassifyResult {
  const presence = r.presence.map((d) => {
    const def = PRESENCE.find((x) => x.id === d.id);
    const { closeLookP, ...first } = d;
    const p = def?.closeLook === false ? undefined : closeLookP;
    return p == null ? { ...first, value: yesNo(d.p, def?.yesMin) } : { ...d, value: yesNo(p, def?.closeLookYesMin ?? def?.yesMin) };
  });
  const yes = new Set(presence.filter((d) => d.value === "true").map((d) => d.id));
  return { ...r, presence, boxes: Object.fromEntries(Object.entries(r.boxes ?? {}).filter(([id]) => yes.has(id))) };
}

// The "In the photo" tags.
export function presenceAttributes(r: Pick<ClassifyResult, "presence">): JevAttribute[] {
  return r.presence.map((d) => ({ attr: d.id, value: d.value, confidence: flagConfidence(d), detail: flagDetail(d) }));
}

const coveredIds = (r: Pick<ClassifyResult, "coverage">) => new Set(r.coverage.filter((c) => (c.pPresent ?? 0) > CONTAINS_MIN).map((c) => c.id));

// Turns a classification into the per-photo attribute rows defined by ATTRIBUTES in questions.ts.
// Tags that don't apply are left out (stored as unknown): sky drama without sky,
// activities without a person, and choices answered "can't tell".
export function toAttributes(r: ClassifyResult): JevAttribute[] {
  const covered = coveredIds(r);
  const personYes = r.presence.some((d) => d.id === "person" && d.value === "true");
  const out: JevAttribute[] = [
    ...r.coverage.map((c) => ({ attr: coverQuestionId(c.id), value: String(c.value), confidence: c.confidence, detail: scoreDetail(c) })),
    ...[...r.moods, ...r.look]
      .filter((m) => m.id !== "sky_drama" || covered.has("sky"))
      .map((m) => ({ attr: m.id, value: String(m.value), confidence: m.confidence, detail: scoreDetail(m) })),
    ...qualityAttributes(r),
    { attr: "primary_scene", value: r.primary.value, confidence: r.primary.confidence },
    ...presenceAttributes(r),
  ];
  for (const f of r.flags) {
    const def = FLAGS.find((x) => x.id === f.id);
    if (def?.requires === "person" && !personYes) continue;
    // Mutually exclusive pairs (hiking / skiing): the less likely of two yeses is stored as unsure.
    const rival = def?.excludes ? r.flags.find((x) => x.id === def.excludes) : undefined;
    const value = f.value === "true" && rival?.value === "true" && (rival.p > f.p || (rival.p === f.p && rival.id < f.id)) ? "uncertain" : f.value;
    out.push({ attr: f.id, value, confidence: flagConfidence(f), detail: flagDetail(f) });
  }
  out.push(...choiceAttributes(r, covered));
  return out;
}

// The quality score, with the model that produced it; nothing when it wasn't answered.
export function qualityAttributes(r: Pick<ClassifyResult, "quality" | "model">): JevAttribute[] {
  const q = r.quality;
  return q ? [{ attr: QUALITY.id, value: String(q.value), confidence: q.confidence, detail: { ...scoreDetail(q), model: r.model } }] : [];
}

// The single-answer categories (weather, …). A dropped option gives way to the most likely remaining one,
// with its probability renormalised over the remaining options as the confidence. When the remaining
// options have under DROPPED_REST_MIN between them, their order is noise, so no value is stored.
const DROPPED_REST_MIN = 0.25;
export function choiceAttributes(r: Pick<ClassifyResult, "choices" | "coverage">, covered = coveredIds(r)): JevAttribute[] {
  const out: JevAttribute[] = [];
  for (const c of r.choices) {
    const def = CHOICES.find((x) => x.id === c.id);
    if (!def) continue;
    let { value, confidence } = c;
    if (def.options.find((o) => o.id === value)?.dropped) {
      const kept = def.options.filter((o) => !o.dropped).map((o) => [o.id, c.probabilities[o.id] ?? 0] as const);
      const total = kept.reduce((s, [, p]) => s + p, 0);
      if (total < DROPPED_REST_MIN) continue;
      const [best, p] = kept.sort((x, y) => y[1] - x[1])[0]!;
      value = best;
      confidence = total ? round3(p / total) : 0;
    }
    if (def.options.find((o) => o.id === value)?.missing) continue;
    if (def.requires && !covered.has(def.requires)) continue;
    out.push({ attr: c.id, value, confidence });
  }
  return out;
}

export function describeJevError(err: unknown): { status: number; body: ApiError } {
  if (err instanceof APIError) {
    const detail = typeof err.body === "string" ? err.body : JSON.stringify(err.body);
    const messages: Record<number, string> = {
      400: "Jev rejected the request (bad image, unsupported model, or the images header is missing).",
      401: "The TypeSafe API key was rejected. Check TYPESAFE_API_KEY.",
      403: "This API key doesn't have access to that model or feature.",
      413: "The image is too large for Jev.",
      429: "Rate limited by TypeSafe. Wait a moment and try again.",
    };
    return {
      // Upstream auth and server failures are a bad gateway from the browser's point of view.
      status: err.status >= 500 || err.status === 401 || err.status === 403 ? 502 : err.status,
      body: {
        error: messages[err.status] ?? `TypeSafe API error (${err.status}).`,
        detail: detail?.slice(0, 500),
        requestId: err.requestId,
      },
    };
  }
  if (err instanceof APIConnectionError) {
    return { status: 504, body: { error: "Couldn't reach TypeSafe (network error or timeout).", detail: err.message } };
  }
  return { status: 500, body: { error: "Unexpected server error.", detail: err instanceof Error ? err.message : String(err) } };
}
