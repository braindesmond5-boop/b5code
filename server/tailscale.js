// Reaching B5 Code from anywhere, over Tailscale: a private network of your
// own devices. `tailscale serve` gives the Mac an HTTPS address only your
// devices can open (https://<mac>.<tailnet>.ts.net), with a real certificate,
// and passes each request on to a port of B5 Code's own on 127.0.0.1. That
// port always demands a paired device: Tailscale delivers its requests from
// this Mac, so they must never be taken for you sitting at it.
//
// Never Funnel: that would put B5 Code on the public internet.
//
// The rules (where Tailscale is, what its status says, the serve commands)
// are pure and tested; running the CLI takes an execFile-like function.

import fs from "node:fs";
import path from "node:path";
import { IS_WIN, findProgram, programFiles } from "./platform.js";

// The standalone app's installer puts a small `tailscale` script in /usr/local/bin that runs the CLI
// inside the app (the way it answered on the owner's Mac); Homebrew puts its own on the PATH.
export const CLI_PLACES = ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

/** The tailscale command, or null if it isn't installed. B5_TAILSCALE names one (the tests' fake). */
export function findCli(env = process.env, exists = fs.existsSync, win = IS_WIN) {
  if (env.B5_TAILSCALE) return env.B5_TAILSCALE;
  if (win) return findProgram("tailscale", [programFiles("Tailscale\\tailscale.exe", env)], { env, win, exists });
  for (const p of CLI_PLACES) if (exists(p)) return p;
  for (const dir of String(env.PATH || "").split(":")) if (dir && exists(path.posix.join(dir, "tailscale"))) return path.posix.join(dir, "tailscale");
  return null;
}

/**
 * What `tailscale status --json` says, in B5 Code's terms: whether it's
 * connected, the Mac's name on the tailnet, and whether HTTPS certificates
 * are on for it (CertDomains lists the names it can get one for).
 */
export function parseStatus(json) {
  let s;
  try { s = typeof json === "string" ? JSON.parse(json) : json; } catch { return { state: "unknown" }; }
  const backend = String(s?.BackendState || "");
  const dnsName = String(s?.Self?.DNSName || "").replace(/\.$/, "").toLowerCase();
  const certDomains = Array.isArray(s?.CertDomains) ? s.CertDomains.map((d) => String(d).toLowerCase()) : [];
  return {
    state: backend === "Running" ? "running" : backend === "NeedsLogin" || backend === "NeedsMachineAuth" ? "signed-out" : backend === "Stopped" ? "stopped" : backend ? backend.toLowerCase() : "unknown",
    dnsName,
    tailnet: String(s?.CurrentTailnet?.Name || ""),
    magicDNS: !!s?.CurrentTailnet?.MagicDNSEnabled,
    https: !!dnsName && certDomains.includes(dnsName),
    user: String(s?.User?.[s?.Self?.UserID]?.LoginName || ""),
  };
}

/** `tailscale serve` for one HTTPS port of the Mac's tailnet name, to a local port; `off` takes it away again. */
export function serveArgs(httpsPort, localPort, off = false) {
  return off ? ["serve", `--https=${httpsPort}`, "off"] : ["serve", "--bg", `--https=${httpsPort}`, `http://127.0.0.1:${localPort}`];
}

/** Whether `tailscale serve status --json` already sends this HTTPS port to this local port. */
export function serving(statusJson, dnsName, httpsPort, localPort) {
  let s;
  try { s = typeof statusJson === "string" ? JSON.parse(statusJson) : statusJson; } catch { return false; }
  const handlers = s?.Web?.[`${dnsName}:${httpsPort}`]?.Handlers || {};
  return Object.values(handlers).some((h) => String(h?.Proxy || "").replace(/\/$/, "") === `http://127.0.0.1:${localPort}`);
}

/** A link Tailscale prints when something needs allowing in its admin console (Serve, or HTTPS certificates). */
export function adminLink(text) {
  const m = /https:\/\/login\.tailscale\.com\/\S+/.exec(String(text || ""));
  return m ? m[0].replace(/[.,)]+$/, "") : "";
}

/** The remote addresses B5 Code is reached at over the tailnet: the app, and its previews on their own port (another site to the browser). */
export const TAILNET_PREVIEW_HTTPS = 8443;
export function tailnetOrigins(dnsName) {
  return { app: `https://${dnsName}`, preview: `https://${dnsName}:${TAILNET_PREVIEW_HTTPS}` };
}
