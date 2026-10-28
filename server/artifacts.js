// Artifacts: the pages Claude writes (HTML, SVG, Markdown) kept as versions,
// so a thread can show a card for each, open it at once, and step back to
// how it looked before. Each successful write or edit of such a file saves a
// copy under data/artifacts/<hash of its path>/, with an index of versions.
// The naming rules are pure and tested; the rest is plain file keeping.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const ARTIFACT = /\.(html?|svg|md|markdown)$/i;
const SNAPSHOT_MAX = 2 * 1024 * 1024; // bigger files aren't versioned
const VERSIONS_MAX = 50; // per file; the oldest go first

/** What kind of artifact a file is: "page", "image" or "document". */
export function artifactKind(file) {
  const ext = path.extname(String(file)).toLowerCase();
  return ext === ".svg" ? "image" : ext === ".md" || ext === ".markdown" ? "document" : "page";
}

/** A title for the card: the page's <title> or first heading, else its file name. */
export function artifactTitle(file, text) {
  const t = String(text || "");
  const clean = (s) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim().slice(0, 80);
  const kind = artifactKind(file);
  let m;
  if (kind === "document") m = /^\s{0,3}#{1,3}\s+(.+)$/m.exec(t);
  else m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(t) || /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(t);
  return (m && clean(m[1])) || path.basename(String(file));
}

export class Artifacts {
  constructor(dir) {
    this.dir = dir;
    this.pending = new Map(); // tool call id -> file, until its result says it worked
  }

  #folder(file) { return path.join(this.dir, crypto.createHash("sha1").update(file).digest("hex").slice(0, 20)); }
  #index(file) {
    try { return JSON.parse(fs.readFileSync(path.join(this.#folder(file), "index.json"), "utf8")); } catch { return { file, versions: [] }; }
  }

  /** A tool call that may write an artifact: remembered until its result. `cwd` resolves a relative path. */
  noteTool(ev, cwd) {
    const file = ev.change?.file;
    if (ev.kind !== "tool" || !file || !ARTIFACT.test(file)) return;
    this.pending.set(ev.id, path.resolve(cwd || "/", file));
  }

  /** The tool's result: if it wrote an artifact, save the version and return its event. */
  noteResult(ev) {
    if (ev.kind !== "tool_result" || !this.pending.has(ev.id)) return null;
    const file = this.pending.get(ev.id);
    this.pending.delete(ev.id);
    if (!ev.ok) return null;
    return this.save(file);
  }

  /** Keep the file as it is now, as its next version (unless nothing changed). */
  save(file) {
    let real, buf;
    try {
      real = fs.realpathSync(file);
      const st = fs.statSync(real);
      if (!st.isFile() || st.size > SNAPSHOT_MAX) return null;
      buf = fs.readFileSync(real);
    } catch { return null; }
    const folder = this.#folder(real);
    const index = this.#index(real);
    const hash = crypto.createHash("sha1").update(buf).digest("hex");
    const last = index.versions[index.versions.length - 1];
    let v = last?.v || 0;
    if (last?.hash !== hash) {
      v += 1;
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, `${v}${path.extname(real)}`), buf);
      index.versions.push({ v, at: Date.now(), size: buf.length, hash });
      for (const old of index.versions.splice(0, Math.max(0, index.versions.length - VERSIONS_MAX))) {
        fs.rmSync(path.join(folder, `${old.v}${path.extname(real)}`), { force: true });
      }
      fs.writeFileSync(path.join(folder, "index.json"), JSON.stringify({ file: real, versions: index.versions }));
    }
    return { kind: "artifact", path: real, version: v, versions: index.versions.length, title: artifactTitle(real, buf.toString("utf8")), type: artifactKind(real) };
  }

  /** A file's saved versions: [{ v, at, size }] */
  versions(file) {
    return this.#index(file).versions.map(({ v, at, size }) => ({ v, at, size }));
  }

  /** One saved version's bytes, or null. */
  read(file, v) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) return null;
    try { return fs.readFileSync(path.join(this.#folder(file), `${n}${path.extname(file)}`)); } catch { return null; }
  }
}
