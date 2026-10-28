import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadVapid, vapidAuth, encrypt, decrypt, cleanSubscription, sendPush } from "../server/push.js";

const phone = () => {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, auth, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
};

test("a notification decrypts on the phone, and its layout is RFC 8291's", () => {
  const p = phone();
  const msg = encrypt(JSON.stringify({ title: "Flaevo", body: "Claude is asking: Run npm test" }), p.keys);
  assert.equal(msg.readUInt32BE(16), 4096, "record size");
  assert.equal(msg[20], 65, "key id: our one-time public key");
  assert.equal(msg[21], 4, "an uncompressed P-256 point");
  assert.deepEqual(JSON.parse(decrypt(msg, p.ecdh, p.auth)), { title: "Flaevo", body: "Claude is asking: Run npm test" });
  assert.notDeepEqual(encrypt("x", p.keys).subarray(0, 16), encrypt("x", p.keys).subarray(0, 16), "a fresh salt each time");
  // Another phone can't read it.
  const other = phone();
  assert.throws(() => decrypt(msg, other.ecdh, other.auth));
});

test("the VAPID token is ES256-signed by B5 Code's key, for the push service's origin", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "b5-vapid-")), "vapid.json");
  const vapid = loadVapid(file);
  assert.deepEqual(loadVapid(file), vapid, "made once, then kept");
  if (process.platform !== "win32") assert.equal((fs.statSync(file).mode & 0o777), 0o600); // Windows has no modes
  const h = vapidAuth(vapid, "https://fcm.googleapis.com/fcm/send/abc", "mailto:x@example.com", 1_000_000_000_000);
  const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h);
  assert.equal(k, vapid.publicKey);
  const [head, claims, sig] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url")), { aud: "https://fcm.googleapis.com", exp: 1_000_000_000 + 12 * 3600, sub: "mailto:x@example.com" });
  const pub = Buffer.from(vapid.publicKey, "base64url");
  const key = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
  assert.ok(crypto.verify("sha256", Buffer.from(`${head}.${claims}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")));
});

test("only a well-formed subscription is kept", () => {
  const p = phone();
  assert.ok(cleanSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: p.keys }));
  assert.equal(cleanSubscription({ endpoint: "http://fcm.googleapis.com/x", keys: p.keys }), null, "https only");
  assert.equal(cleanSubscription({ endpoint: "https://x.com/y", keys: { p256dh: "abc", auth: p.keys.auth } }), null);
});

test("a subscription's address is a browser's push service, never anywhere a phone says", () => {
  const p = phone();
  for (const ok of ["https://fcm.googleapis.com/fcm/send/x", "https://web.push.apple.com/abc", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://wns2-par02p.notify.windows.com/w/?token=x"]) {
    assert.ok(cleanSubscription({ endpoint: ok, keys: p.keys }), ok);
  }
  for (const bad of ["https://192.168.1.1/cgi-bin/x", "https://evil.example/push", "https://fcm.googleapis.com.evil.example/x", "https://fcm.googleapis.com:8443/x", "https://user@fcm.googleapis.com/x"]) {
    assert.equal(cleanSubscription({ endpoint: bad, keys: p.keys }), null, bad);
  }
});

test("sending posts the encrypted body with the push headers; a gone phone is said so", async () => {
  const p = phone();
  const vapid = loadVapid(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "b5-vapid-")), "v.json"));
  let seen;
  const r = await sendPush({ endpoint: "https://push.example/abc", keys: p.keys }, { title: "Hi" }, vapid, async (url, opts) => { seen = { url, opts }; return { status: 201 }; });
  assert.deepEqual(r, { ok: true, gone: false, status: 201 });
  assert.equal(seen.opts.headers["content-encoding"], "aes128gcm");
  assert.match(seen.opts.headers.authorization, /^vapid t=/);
  assert.deepEqual(JSON.parse(decrypt(seen.opts.body, p.ecdh, p.auth)), { title: "Hi" });
  assert.equal((await sendPush({ endpoint: "https://push.example/abc", keys: p.keys }, {}, vapid, async () => ({ status: 410 }))).gone, true);
});

test("encryption matches RFC 8291's own worked example, byte for byte", () => {
  const local = crypto.createECDH("prime256v1");
  local.setPrivateKey(Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url"));
  const out = encrypt("When I grow up, I want to be a watermelon", {
    p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg",
  }, { salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"), local });
  assert.equal(out.toString("base64url"), "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
});
