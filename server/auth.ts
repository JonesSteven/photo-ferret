import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

// Single admin account from .env, with a stateless HMAC-signed session cookie.
const COOKIE = "pan_session";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const FAILED_LOGIN_DELAY_MS = 800;

const SECRET =
  process.env.SESSION_SECRET ||
  (() => {
    console.warn("[auth] SESSION_SECRET is not set; using a random one, so admin sessions end when the server restarts.");
    return randomBytes(32).toString("hex");
  })();

export const adminConfigured = () => Boolean(process.env.ADMIN_USER && process.env.ADMIN_PASSWORD);

// Hash first so the comparison is constant-time regardless of input length.
const sameText = (a: string, b: string) =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

const sign = (payload: string) => createHmac("sha256", SECRET).update(payload).digest("base64url");

export async function checkLogin(user: string, password: string) {
  // Check both fields every time, so timing doesn't reveal which one was wrong.
  const userOk = sameText(user, process.env.ADMIN_USER ?? "");
  const passwordOk = sameText(password, process.env.ADMIN_PASSWORD ?? "");
  const ok = adminConfigured() && userOk && passwordOk;
  if (!ok) await new Promise((r) => setTimeout(r, FAILED_LOGIN_DELAY_MS));
  return ok;
}

export function setSession(req: Request, res: Response) {
  const expires = Date.now() + MAX_AGE_MS;
  // The username is part of the signature, so changing ADMIN_USER signs everyone out.
  const value = `${expires}.${sign(`${process.env.ADMIN_USER}.${expires}`)}`;
  res.cookie(COOKIE, value, { httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: MAX_AGE_MS, path: "/" });
}

export function clearSession(res: Response) {
  res.clearCookie(COOKIE, { path: "/" });
}

function readCookie(req: Request, name: string) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function isAdmin(req: Request) {
  if (!adminConfigured()) return false;
  const [expires, sig] = (readCookie(req, COOKIE) ?? "").split(".");
  if (!expires || !sig || Number(expires) < Date.now()) return false;
  const expected = Buffer.from(sign(`${process.env.ADMIN_USER}.${expires}`));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: "Please sign in." });
}
