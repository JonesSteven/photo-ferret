import path from "node:path";
import type { PublicPhoto, SiteData } from "../shared/types.ts";
import { attributesFor, getSettings, listPhotos } from "./db.ts";
import { toPublic } from "./photos.ts";
import { ATTRIBUTES } from "./questions.ts";

// The static site's data.json: the settings, the public attribute definitions and the published photos.
// Used by npm run export-site and, in dev, served live by the local server, so both see the same data.
// Nothing private goes in: no internal ids, original names, Jev's raw output or confidences, and no
// unpublished photos.

// The exported site's folder (gitignored; deployed with wrangler, see wrangler.jsonc).
export const SITE_DIR = path.resolve(process.env.SITE_DIR || "site");

export type SiteImage = "thumb" | "display";

// A published photo's derived image, by its public number (the site's image paths use it).
export interface SitePhoto {
  id: string; // internal
  seq: number;
}

export function buildSiteData(imageUrl: (photo: SitePhoto, kind: SiteImage) => string): { data: SiteData; photos: SitePhoto[] } {
  const rows = listPhotos({ publicOnly: true });
  const attrs = attributesFor(rows.map((r) => r.id));
  const photos: SitePhoto[] = [];
  const list = rows.map((row): PublicPhoto => {
    const p = toPublic(row, attrs.get(row.id) ?? []);
    const site = { id: row.id, seq: row.seq };
    photos.push(site);
    // Box confidences are Jev's and the gallery doesn't show them.
    const boxes = p.boxes.map((b) => ({ ...b, confidence: null }));
    return { ...p, id: String(row.seq), boxes, thumbUrl: imageUrl(site, "thumb"), displayUrl: imageUrl(site, "display") };
  });
  return {
    data: { settings: getSettings(), attributes: ATTRIBUTES.filter((a) => !a.adminOnly), photos: list },
    photos,
  };
}
