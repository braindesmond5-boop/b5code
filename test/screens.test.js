import { test } from "node:test";
import assert from "node:assert/strict";
import { SCREENS, screenById, fitScreen } from "../web/screens.js";

test("every screen has a unique id and a sensible size", () => {
  const all = SCREENS.flatMap((g) => g.items);
  assert.equal(new Set(all.map((s) => s.id)).size, all.length);
  for (const s of all) assert.ok(s.w >= 320 && s.h >= 600 && s.w <= 1440, s.id);
  assert.equal(screenById("pixel-7").w, 412);
  assert.equal(screenById("nope"), null, "an unknown id fills the pane");
});

test("a screen is scaled down to fit its box, never up", () => {
  const pixel = screenById("pixel-7");
  const big = fitScreen(pixel, false, 2000, 2000);
  assert.deepEqual([big.w, big.h, big.scale], [412, 915, 1], "room to spare: shown 1:1");
  assert.deepEqual([big.outerW, big.outerH], [432, 935], "the frame adds its bezel on each side");

  const small = fitScreen(pixel, false, 500, 491);
  assert.equal(small.scale, (491 - 24) / 935, "the height is what limits a tall phone");
  assert.ok(small.outerW * small.scale <= 500 - 24);

  const turned = fitScreen(pixel, true, 2000, 2000);
  assert.deepEqual([turned.w, turned.h], [915, 412], "turned sideways");
  const se = fitScreen(screenById("iphone-se"), true, 2000, 2000);
  assert.deepEqual([se.outerW, se.outerH], [667 + 24 + 112, 375 + 24], "the home-button band moves to the sides");
  assert.equal(fitScreen(pixel, false, 0, 0).scale, 0.1, "a hidden pane doesn't make the scale zero");
});
