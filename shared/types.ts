// The JSON contracts between the server and the web clients (the admin, and the gallery's data.json).

// ---- Jev classification (server/jev.ts normalize) ----

export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

// One Score answer, mapped to a 0–100 position (coverage % for surfaces, scale position for moods).
export interface ScoreReading {
  id: string;
  value: number; // 0–100
  score: number; // raw expected score on the rubric
  max: number; // top rubric level
  confidence: number;
  probabilities: number[]; // one per rubric level
  mode: number; // most likely level
  uncertain: boolean; // two separated levels both likely (e.g. None vs About half), so the average misleads
  pPresent?: number; // coverage only: 1 − P(None)
}

// A yes/no answer. p is Jev's probability of yes; value applies the thresholds in jev.ts.
export type YesNo = "true" | "false" | "uncertain";
export interface FlagReading {
  id: string;
  p: number;
  value: YesNo;
  closeLookP?: number; // second pass on sharper tiles, when the first answer was uncertain
}

export interface ChoiceReading {
  id: string;
  value: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ClassifyResult {
  image: { width: number; height: number; originalFormat: string; resized: boolean; tiles?: number }; // the JPEG sent to Jev
  coverage: ScoreReading[]; // % of the frame per surface or subject
  moods: ScoreReading[]; // position on each mood scale
  look: ScoreReading[]; // position on each look & composition scale
  quality?: ScoreReading; // overall quality, 1–100; missing in results stored before it was asked, or if unanswered
  primary: ChoiceReading;
  choices: ChoiceReading[]; // weather, water state
  presence: FlagReading[]; // people, wildlife, birds, tents, structures, vehicles, flowers
  flags: FlagReading[]; // sky features, water features, activities
  boxes: Record<string, { box: Box; confidence: number | null }>; // per presence id, only when that tag is "true"
  model: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
  elapsedMs: number;
}

// ---- Photo metadata ----

// A piece of metadata stored per photo. Defined once in server/questions.ts (ATTRIBUTES).
// Values are strings: "true"/"false"/"uncertain" for boolean, an option id for choice, comma-separated
// option ids for multi, and a number from 0 to 100 for percent (share of the frame) and scale (position
// between the two ends of a scale). A missing value means unknown or not applicable, never zero.
export interface AttributeDef {
  id: string;
  label: string;
  kind: "boolean" | "choice" | "multi" | "percent" | "scale";
  group: "surface" | "mood" | "colour" | "look" | "primary" | "presence" | "activity" | "sky";
  source: "jev" | "computed"; // computed = measured in code, not asked of Jev
  adminOnly?: boolean; // stored and shown in the admin, but not offered as a public filter
  options?: { id: string; label: string; swatch?: string }[]; // choice and multi
  ends?: [string, string]; // scale only: labels for 0 and 100
  levels?: string[]; // scale only: short labels for each rubric level, low to high
}

// Per-attribute detail from the last Jev run.
export interface AttributeDetail {
  p?: number; // boolean: probability of yes
  closeLookP?: number; // boolean: probability of yes on the sharper second pass
  probabilities?: number[]; // scale and percent: one per rubric level
  mode?: number; // most likely rubric level
  pPresent?: number; // percent: 1 − P(None)
  uncertain?: boolean; // scale and percent: bimodal answer
  model?: string; // quality only: the Jev model that scored it (scores from different models may not compare)
}

export interface AttributeValue {
  attr: string;
  jevValue: string | null;
  jevConfidence: number | null; // boolean: |2p − 1|; scale/percent/choice: Jev's confidence; null if computed
  detail: AttributeDetail | null;
  override: string | null; // set by the admin; wins over jevValue
  value: string | null; // effective value: override ?? jevValue
}

// A photo as the gallery sees it (data.json). In the static site, id is the image number ("12"), so the
// internal id never leaves the owner's computer; in the admin it is the internal id.
export interface PublicPhoto {
  id: string;
  title: string | null;
  description: string | null;
  number: number; // 12: the image number, in upload order
  name: string; // "Image 12": the public name
  width: number | null; // upright original dimensions
  height: number | null;
  takenAt: string | null; // EXIF DateTimeOriginal, "YYYY-MM-DDTHH:MM:SS" camera local time
  attrs: Record<string, string>; // effective values only
  contains: string[]; // percent attributes judged present (P(present) > 0.5, or an override above 0)
  unsure: string[]; // scale/percent attributes whose answer was split between distant levels
  // Where the most prominent person, animal, vehicle… is, for each "In the photo" tag that is "yes".
  // Fractions of the image (jev.jpg and the display image share the framing).
  boxes: { id: string; label: string; box: Box; confidence: number | null }[];
  thumbUrl: string;
  displayUrl: string;
}

export interface PhotoListResponse {
  photos: PublicPhoto[];
  total: number; // all public photos, before filtering
  // For each attribute, counts given the *other* active filters: per value for boolean/choice/multi, and
  // "present" (judged present, see PublicPhoto.contains) for percent attributes.
  facets: Record<string, Record<string, number>>;
  // Numeric attributes only: 10 buckets (0–10, 10–20, … 90–100), also given the other active filters.
  histograms: Record<string, number[]>;
  // Map view only: every photo passing the other filters, placed in both rectangles.
  mapPoints?: MapPoint[];
  colourAxis?: [number, number][]; // the cube's stretched colour axis: [cube position, colour-axis position]
  colourPoints?: ColourPoint[]; // Sliders view: the colour picker's dots
}

// A photo's position in the map view's cube, each axis 0–100.
export interface MapPoint {
  id: string;
  title: string;
  thumbUrl: string;
  pos: [number, number, number]; // water → mountains, main colour (neutral photos in a band at the bottom), scale
  match: boolean;
}

// A dot on the colour picker: x on the colour axis (neutral band 0–10, hues 12–100), y saturation.
export interface ColourPoint {
  id: string;
  title: string;
  thumbUrl: string;
  x: number;
  y: number;
  match: boolean;
}

export type JevStatus = "pending" | "done" | "error";

export interface AdminPhoto extends PublicPhoto {
  originalName: string; // the uploaded file's name, shown only in the admin
  fileName: string; // "Image_12.jpg": the original's download name
  bytes: number;
  originalUrl: string;
  published: boolean;
  createdAt: string;
  derivedReady: boolean; // thumb/display/jev images exist
  jevStatus: JevStatus;
  jevError: string | null;
  jevModel: string | null;
  classifiedAt: string | null;
  attributes: AttributeValue[];
  tiles: number | null; // set when a panorama was analysed in several tiles
  jevUrl: string; // the exact JPEG sent to Jev, so the boxes line up
}

// Possible duplicates, for the admin (see server/duplicates.ts).
export interface DuplicateGroup {
  ids: string[]; // by capture time
  similarity: number; // the closest pair's correlation, up to 1
  spanSeconds: number | null; // first to last capture time; null when any photo has none
  panorama: boolean; // matched as panorama versions
}

export interface DuplicateReport {
  groups: DuplicateGroup[];
  unfingerprinted: number; // visible photos not fingerprinted yet (npm run fingerprint)
}

export interface PhotoPatch {
  title?: string | null;
  description?: string | null;
  published?: boolean;
  overrides?: Record<string, string | null>; // null clears the override (back to Jev)
}

export interface UploadResult {
  name: string;
  photo?: AdminPhoto;
  error?: string;
}

// Coverage levels: the share of the frame each rubric level stands for, and the words shown for it.
export const COVER_LEVELS = [
  { share: 0, label: "None" },
  { share: 4, label: "Trace" },
  { share: 22, label: "Some" },
  { share: 50, label: "About half" },
  { share: 75, label: "Most" },
  { share: 95, label: "Nearly all" },
];

export interface ApiError {
  error: string;
  detail?: string;
  requestId?: string;
}

// Site settings, changed in the admin.
export interface SiteSettings {
  siteTitle: string; // the gallery's name: page title and the header
  aboutText: string; // the owner's note at the top of the About page (plain text; may be empty)
}
// The static site's one data file (npm run export-site; served live by the local server in dev).
export interface SiteData {
  settings: SiteSettings;
  attributes: AttributeDef[]; // the public ones only
  photos: PublicPhoto[]; // published only, newest upload first
}

export const DEFAULT_SETTINGS: SiteSettings = { siteTitle: "Photo Ferret", aboutText: "" };
export const SITE_TITLE_MAX = 80;
export const ABOUT_TEXT_MAX = 4000;
