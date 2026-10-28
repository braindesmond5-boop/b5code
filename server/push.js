// Notifications on the phone, by the web's own Web Push: the phone's browser
// gives B5 Code an address at its push service (Chrome: Google's), and B5
// Code sends each notification there, encrypted so only that phone can read
// it. Nothing to install: Node's own crypto does all of it.
//
//   RFC 8291  Message Encryption for Web Push (aes128gcm)
//   RFC 8292  VAPID: who is sending (an ES256-signed token)
//
// The crypto is pure and tested (an encrypted message decrypts back; a VAPID
// token verifies); sending takes a fetch-like function.

import crypto from "node:crypto";
import fs from "node:fs";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(String(s), "base64url");

/** B5 Code's VAPID key pair, made once and kept in `file` (readable only by you). */
export function loadVapid(file) {
  try {
    const k = JSON.parse(fs.readFileSync(file, "utf8"));
    if (k.publicKey && k.privateKey) return k;
  } catch { /* first time */ }
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const k = { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
  fs.writeFileSync(file, JSON.stringify(k), { mode: 0o600 });
  return k;
}

/** The VAPID key as a signing key (JWK from its raw P-256 numbers). */
function signingKey(vapid) {
  const pub = unb64u(vapid.publicKey); // 0x04 || x || y
  return crypto.createPrivateKey({ key: { kty: "EC", crv: "P-256", d: vapid.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: "jwk" });
}

/** The Authorization header for a push service: a VAPID token for its origin, signed ES256. */
export function vapidAuth(vapid, endpoint, subject = "mailto:b5code@example.com", now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign("sha256", Buffer.from(`${header}.${claims}`), { key: signingKey(vapid), dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${vapid.publicKey}`;
}

const hkdf = (salt, ikm, info, len) => Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, len));

/**
 * Encrypt a payload for one subscription (RFC 8291, one record). `keys` are
 * the subscription's p256dh (the phone's public key) and auth (its secret).
 * `salt` and `local` (our one-time key pair) are only passed in by tests.
 */
export function encrypt(payload, keys, { salt = crypto.randomBytes(16), local = null } = {}) {
  const uaPublic = unb64u(keys.p256dh);
  const auth = unb64u(keys.auth);
  const ecdh = local || crypto.createECDH("prime256v1");
  if (!local) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = hkdf(auth, shared, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  // The last (only) record ends with a 0x02 padding delimiter.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** The other end of `encrypt`, as the phone does it: for the tests. */
export function decrypt(message, uaEcdh, authSecret) {
  const salt = message.subarray(0, 16);
  const idlen = message[20];
  const asPublic = message.subarray(21, 21 + idlen);
  const body = message.subarray(21 + idlen);
  const shared = uaEcdh.computeSecret(asPublic);
  const ikm = hkdf(authSecret, shared, Buffer.concat([Buffer.from("WebPush: info\0"), uaEcdh.getPublicKey(), asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(body.subarray(body.length - 16));
  const plain = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString("utf8");
}

/** A subscription as the browser hands it over, checked: an https endpoint and its two keys. */
// The browsers' push services: a subscription's address is always one of these. Anything else
// would have the Mac post to wherever a phone (paired, or stolen) said, inside your network too.
const PUSH_HOSTS = /^(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|(?:[\w-]+\.)*push\.apple\.com|(?:[\w-]+\.)*notify\.windows\.com)$/i;

export function cleanSubscription(sub) {
  const endpoint = String(sub?.endpoint || "");
  const p256dh = String(sub?.keys?.p256dh || ""), auth = String(sub?.keys?.auth || "");
  if (!/^https:\/\/[^\s/]+\//.test(endpoint) || endpoint.length > 2000) return null;
  let host = "";
  try { const u = new URL(endpoint); host = u.port || u.username || u.password ? "" : u.hostname; } catch { return null; }
  if (!PUSH_HOSTS.test(host)) return null;
  if (unb64u(p256dh).length !== 65 || unb64u(auth).length !== 16) return null;
  return { endpoint, keys: { p256dh, auth } };
}

/**
 * Send one notification. Resolves { ok, gone }: gone means the phone has
 * unsubscribed (410/404), so the subscription should be forgotten.
 */
export async function sendPush(sub, data, vapid, fetchFn = fetch) {
  const res = await fetchFn(sub.endpoint, {
    method: "POST",
    headers: { authorization: vapidAuth(vapid, sub.endpoint), "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: "high" },
    body: encrypt(JSON.stringify(data), sub.keys),
    redirect: "manual", // a push service answers itself; it never sends us somewhere else
  });
  const ok = res.status >= 200 && res.status < 300;
  // The push service's own words, for a refusal: they say what was wrong (a bad key, an old subscription).
  const said = ok ? "" : String(await res.text?.().catch(() => "") || "").replace(/\s+/g, " ").trim().slice(0, 200);
  return { ok, gone: res.status === 404 || res.status === 410, status: res.status, ...(said ? { said } : {}) };
}
