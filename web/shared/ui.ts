import { type ApiError, type AttributeDef, type Box, COVER_LEVELS } from "../../shared/types.ts";

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export const pct = (p: number) => `${Math.round(p * 100)}%`;

export function formatBytes(n: number) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// Small element builder: el("span", { class: "chip", text: "Lake" }, child, ...)
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | boolean | undefined> & { text?: string } = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue;
    if (k === "text") node.textContent = String(v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: json === undefined ? rest.headers : { "Content-Type": "application/json", ...rest.headers },
    body: json === undefined ? rest.body : JSON.stringify(json),
  });
  const body = (await res.json().catch(() => ({ error: `Server returned ${res.status}` }))) as T | ApiError;
  if (!res.ok) {
    const e = body as ApiError;
    throw new HttpError([e.error, e.requestId && `(request ${e.requestId})`].filter(Boolean).join(" "), res.status);
  }
  return body as T;
}

// Human-readable label for an attribute value ("true" -> "Yes", "green,blue" -> "Green, Blue").
export function valueLabel(def: AttributeDef, value: string | null | undefined) {
  if (value == null) return "—";
  if (def.kind === "boolean") return value === "true" ? "Yes" : value === "false" ? "No" : "Unsure";
  if (def.kind === "percent") return `${coverWord(Number(value))} · ~${Math.round(Number(value))}%`; // no presence info here
  if (def.kind === "scale") return levelLabel(def, Number(value));
  const label = (id: string) => def.options?.find((o) => o.id === id)?.label ?? id;
  return def.kind === "multi" ? value.split(",").map(label).join(", ") : label(value);
}

// Coverage word for an expected share of the frame: the nearest rubric level (Trace, Some, About half…).
// A category judged present is at least a trace, even when its expected share rounds to none.
export function coverWord(n: number, present = false) {
  const word = COVER_LEVELS.reduce((best, l) => (Math.abs(l.share - n) < Math.abs(best.share - n) ? l : best)).label;
  return present && word === COVER_LEVELS[0]!.label ? COVER_LEVELS[1]!.label : word;
}

export const isNumeric = (def: AttributeDef) => def.kind === "percent" || def.kind === "scale";

// Nearest rubric level's short label for a 0–100 scale position.
export function levelLabel(def: AttributeDef, n: number) {
  const levels = def.levels ?? [];
  if (!levels.length) return String(Math.round(n));
  return levels[Math.round((n / 100) * (levels.length - 1))] ?? "";
}

// Positions a box overlay (fractions of the image) inside its relatively positioned frame.
export function placeBox(boxEl: HTMLElement, b: Box | null, label: string) {
  boxEl.hidden = !b;
  if (!b) return;
  Object.assign(boxEl.style, {
    left: pct(b.left),
    top: pct(b.top),
    width: pct(b.right - b.left),
    height: pct(b.bottom - b.top),
  });
  boxEl.replaceChildren(el("span", { text: label }));
}

// Moves the range [a, b] by delta while keeping its width, stopping at the 0 and 100 edges.
export function shiftWindow(a: number, b: number, delta: number): [number, number] {
  const shift = Math.max(-a, Math.min(100 - b, delta));
  return [a + shift, b + shift];
}
