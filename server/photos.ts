import type { AdminPhoto, AttributeValue, ClassifyResult, PublicPhoto } from "../shared/types.ts";
import { attributesFor, type PhotoRow } from "./db.ts";
import { CONTAINS_MIN } from "./jev.ts";
import { ATTRIBUTES, PRESENCE } from "./questions.ts";
import { publicFileName, publicName } from "./storage.ts";

// Maps database rows to the API shapes. The gallery's filtering is in shared/gallery.ts.

const PERCENT_IDS = new Set(ATTRIBUTES.filter((a) => a.kind === "percent").map((a) => a.id));

// Is a coverage category present? An admin override decides (0 = absent); otherwise Jev's P(any amount).
function isPresent(a: AttributeValue) {
  if (a.override != null) return Number(a.override) > 0;
  return a.detail?.pPresent != null && a.detail.pPresent > CONTAINS_MIN;
}

// Boxes from the last Jev run, for the tags that are "yes" now (an admin override to "no" hides its box).
function photoBoxes(row: PhotoRow, attrs: Record<string, string>): PublicPhoto["boxes"] {
  if (!row.jev_result) return [];
  const result = JSON.parse(row.jev_result) as ClassifyResult;
  return Object.entries(result.boxes ?? {})
    .filter(([id]) => attrs[id] === "true")
    .map(([id, b]) => ({ id, label: PRESENCE.find((p) => p.id === id)?.boxLabel ?? id, box: b.box, confidence: b.confidence }));
}

export function toPublic(row: PhotoRow, attributes: AttributeValue[]): PublicPhoto {
  const attrs: Record<string, string> = {};
  const contains: string[] = [];
  const unsure: string[] = [];
  for (const a of attributes) {
    if (a.value == null) continue;
    attrs[a.attr] = a.value;
    // A category judged absent counts as 0% everywhere (sliders, histograms, sorting), not as its expected
    // share: P(None) 0.8 with a little weight on large shares averages to ~6%, though Jev says "no".
    if (PERCENT_IDS.has(a.attr)) {
      if (isPresent(a)) contains.push(a.attr);
      else attrs[a.attr] = "0";
    }
    if (a.override == null && a.detail?.uncertain) unsure.push(a.attr);
  }
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    number: row.seq,
    name: publicName(row.seq),
    width: row.width,
    height: row.height,
    takenAt: row.taken_at,
    attrs,
    contains,
    unsure,
    boxes: photoBoxes(row, attrs),
    thumbUrl: `/media/${row.id}/thumb`,
    displayUrl: `/media/${row.id}/display`,
  };
}

export function toAdmin(row: PhotoRow, attributes: AttributeValue[]): AdminPhoto {
  const result = row.jev_result ? (JSON.parse(row.jev_result) as ClassifyResult) : null;
  const known = new Map(attributes.map((a) => [a.attr, a]));
  return {
    ...toPublic(row, attributes),
    originalName: row.original_name,
    fileName: publicFileName(row.seq, row.original_ext),
    bytes: row.bytes,
    originalUrl: `/media/${row.id}/original`,
    published: Boolean(row.published),
    createdAt: row.created_at,
    derivedReady: Boolean(row.derived_ready),
    jevStatus: row.jev_status,
    jevError: row.jev_error,
    jevModel: row.jev_model,
    classifiedAt: row.classified_at,
    // Always one entry per defined attribute, in definition order, even before Jev has run.
    attributes: ATTRIBUTES.map(
      (def) => known.get(def.id) ?? { attr: def.id, jevValue: null, jevConfidence: null, detail: null, override: null, value: null },
    ),
    tiles: result?.image?.tiles ?? null,
    jevUrl: `/media/${row.id}/jev`,
  };
}

export function adminPhotos(rows: PhotoRow[]) {
  const attrs = attributesFor(rows.map((r) => r.id));
  return rows.map((r) => toAdmin(r, attrs.get(r.id) ?? []));
}
