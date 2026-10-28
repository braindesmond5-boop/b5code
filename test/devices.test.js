import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyDevices, newPairing, redeem, deviceFor, removeDevice, deviceName, PAIR_TTL_MS, PAIR_TRIES, DEVICE_TTL_MS } from "../server/devices.js";

test("the QR secret or the six digits pair a device, once", () => {
  const { state, pair } = newPairing(emptyDevices(), 0);
  const r = redeem(state, { secret: pair.secret, name: "iPhone" }, 1);
  assert.equal(r.ok, true);
  assert.equal(r.state.devices.length, 1);
  assert.ok(deviceFor(r.state, r.key, 2));
  assert.equal(redeem(r.state, { secret: pair.secret }, 3).ok, false, "the code is used up");

  const { state: s2, pair: p2 } = newPairing(emptyDevices(), 0);
  assert.equal(redeem(s2, { digits: p2.digits.slice(0, 3) + " " + p2.digits.slice(3) }, 1).ok, true, "spaces in the digits are fine");
});

test("wrong codes, expired codes and too many tries all fail", () => {
  const { state, pair } = newPairing(emptyDevices(), 0);
  assert.equal(redeem(state, { secret: pair.secret }, PAIR_TTL_MS + 1).ok, false);
  let s = state;
  for (let i = 0; i < PAIR_TRIES; i++) s = redeem(s, { digits: "000000" === pair.digits ? "111111" : "000000" }, 1).state;
  assert.equal(s.pair, null, "the code is gone after too many tries");
  assert.equal(redeem(s, { digits: pair.digits }, 2).ok, false);
});

test("only the key's hash is kept, devices expire, and can be removed", () => {
  const { state, pair } = newPairing(emptyDevices(), 0);
  const r = redeem(state, { secret: pair.secret }, 0);
  assert.ok(!JSON.stringify(r.state).includes(r.key), "the raw key is never stored");
  assert.equal(deviceFor(r.state, "not-the-key", 1), null);
  assert.equal(deviceFor(r.state, r.key, DEVICE_TTL_MS + 1), null);
  assert.equal(deviceFor(removeDevice(r.state, r.state.devices[0].id), r.key, 1), null);
});

test("device names from the browser", () => {
  assert.equal(deviceName("Mozilla/5.0 (Linux; Android 16; SM-S921B) Mobile Safari"), "Android phone");
  assert.equal(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)"), "iPhone");
});
