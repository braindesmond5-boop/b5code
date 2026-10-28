// Screen sizes for Preview: a page shown as it looks on an Android phone,
// an iPhone, a tablet or a laptop. Sizes are the CSS viewport each device
// reports (what a page's media queries see), from Chrome's device list.
// Pure, so the sizing is tested.

export const SCREENS = [
  { group: "Android phones", items: [
    { id: "pixel-7", name: "Pixel 7", w: 412, h: 915, kind: "android" },
    { id: "galaxy-s24", name: "Galaxy S24", w: 360, h: 780, kind: "android" },
    { id: "galaxy-a51", name: "Galaxy A51", w: 412, h: 914, kind: "android" },
    { id: "galaxy-s8", name: "Galaxy S8+", w: 360, h: 740, kind: "android" },
    { id: "galaxy-fold", name: "Galaxy Z Fold 5 (folded)", w: 344, h: 882, kind: "android" },
  ] },
  { group: "iPhones", items: [
    { id: "iphone-se", name: "iPhone SE", w: 375, h: 667, kind: "iphone-old" },
    { id: "iphone-15", name: "iPhone 15", w: 393, h: 852, kind: "iphone" },
    { id: "iphone-15-max", name: "iPhone 15 Pro Max", w: 430, h: 932, kind: "iphone" },
  ] },
  { group: "Tablets", items: [
    { id: "nexus-7", name: "Nexus 7 (small Android)", w: 600, h: 960, kind: "tablet" },
    { id: "galaxy-tab-s4", name: "Galaxy Tab S4", w: 712, h: 1138, kind: "tablet" },
    { id: "ipad-mini", name: "iPad mini", w: 768, h: 1024, kind: "tablet" },
    { id: "ipad-air", name: "iPad Air", w: 820, h: 1180, kind: "tablet" },
    { id: "surface-pro", name: "Surface Pro 7", w: 912, h: 1368, kind: "tablet" },
    { id: "ipad-pro", name: "iPad Pro 12.9″", w: 1024, h: 1366, kind: "tablet" },
  ] },
  { group: "Computers", items: [
    { id: "laptop", name: "Laptop", w: 1280, h: 800, kind: "computer" },
    { id: "desktop", name: "Desktop", w: 1440, h: 900, kind: "computer" },
  ] },
];

const ALL = SCREENS.flatMap((g) => g.items);

/** A screen by id, or null (null means: fill the pane). */
export const screenById = (id) => ALL.find((s) => s.id === id) || null;

// The frame around the screen, in CSS pixels, per side.
const BEZEL = { android: 10, iphone: 12, "iphone-old": 12, tablet: 18, computer: 0 };
const CHIN = { "iphone-old": 56 }; // the old iPhone's home-button band, top and bottom

/**
 * How big to draw a screen in a box: the page's viewport (turned if
 * `turned`), the frame's outer size, and the scale that fits it all
 * (never larger than 1:1).
 */
export function fitScreen(screen, turned, boxW, boxH, margin = 24) {
  const w = turned ? screen.h : screen.w, h = turned ? screen.w : screen.h;
  const bezel = BEZEL[screen.kind] ?? 0;
  const chin = CHIN[screen.kind] || 0;
  const outerW = w + 2 * bezel + (turned ? 2 * chin : 0);
  const outerH = h + 2 * bezel + (turned ? 0 : 2 * chin);
  const scale = Math.max(0.1, Math.min(1, (boxW - margin) / outerW, (boxH - margin) / outerH)) || 1;
  return { w, h, bezel, chin, outerW, outerH, scale };
}
