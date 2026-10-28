// Phones (or any other device) allowed to use B5 Code over your network.
//
// Pairing: B5 Code on the Mac makes a one-time code, shown as a QR code
// (a long secret in a link) and as six digits to type. A device that brings
// either gets a random device key in a cookie; only a hash of it is kept
// here. Codes last 10 minutes; the six digits allow 5 wrong tries.
// The rules are pure functions over a plain state object, tested in Node.

import crypto from "node:crypto";

export const PAIR_TTL_MS = 10 * 60 * 1000;
export const PAIR_TRIES = 5;
export const DEVICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const hashKey = (key) => crypto.createHash("sha256").update(String(key)).digest("hex");

export const emptyDevices = () => ({ devices: [], pair: null });

/** A fresh pairing code. */
export function newPairing(state, now = Date.now()) {
  const pair = {
    secret: crypto.randomBytes(16).toString("hex"),
    digits: String(crypto.randomInt(0, 1_000_000)).padStart(6, "0"),
    expires: now + PAIR_TTL_MS,
    tries: 0,
  };
  return { state: { ...state, pair }, pair };
}

/**
 * Try a code from a device: the long secret (from the QR link) or the six
 * digits. Success uses the code up and adds the device.
 * @returns {{state: object, ok: boolean, key?: string, reason?: string}}
 */
export function redeem(state, { secret = "", digits = "", name = "Device" }, now = Date.now()) {
  const p = state.pair;
  if (!p || now > p.expires) return { state: { ...state, pair: null }, ok: false, reason: "That code has expired. Make a new one in B5 Code's Settings." };
  if (p.tries >= PAIR_TRIES) return { state: { ...state, pair: null }, ok: false, reason: "Too many tries. Make a new code in B5 Code's Settings." };
  const good = (secret && safeEqual(secret, p.secret)) || (digits && safeEqual(String(digits).replace(/\D/g, ""), p.digits));
  if (!good) {
    const pair = { ...p, tries: p.tries + 1 };
    return { state: { ...state, pair: pair.tries >= PAIR_TRIES ? null : pair }, ok: false, reason: "That code isn't right." };
  }
  const key = crypto.randomBytes(24).toString("hex");
  const device = { id: crypto.randomBytes(6).toString("hex"), name: String(name).slice(0, 60), hash: hashKey(key), createdAt: now, lastSeen: now };
  return { state: { ...state, pair: null, devices: [...state.devices, device] }, ok: true, key };
}

/** The device a cookie's key belongs to, if any and not expired. */
export function deviceFor(state, key, now = Date.now()) {
  if (!key) return null;
  const h = hashKey(key);
  return state.devices.find((d) => d.hash === h && now - d.createdAt < DEVICE_TTL_MS) || null;
}

export function removeDevice(state, id) {
  return { ...state, devices: state.devices.filter((d) => d.id !== id) };
}

/** A short name from a browser's user agent: "iPhone", "Android phone"… */
export function deviceName(ua = "") {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  return "Device";
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
