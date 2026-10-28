import { test } from "node:test";
import assert from "node:assert/strict";
import { findCli, parseStatus, serveArgs, serving, adminLink, tailnetOrigins } from "../server/tailscale.js";

test("the Tailscale command is found in the Mac app, Homebrew or the PATH", () => {
  assert.equal(findCli({}, (p) => p === "/Applications/Tailscale.app/Contents/MacOS/Tailscale", false), "/Applications/Tailscale.app/Contents/MacOS/Tailscale");
  assert.equal(findCli({}, () => true, false), "/usr/local/bin/tailscale", "the installer's script first");
  assert.equal(findCli({ PATH: "/x:/y" }, (p) => p === "/y/tailscale", false), "/y/tailscale");
  assert.equal(findCli({ PATH: "/x" }, () => false, false), null);
});

test("Tailscale's status: connected, the Mac's name, and whether HTTPS certificates are on", () => {
  const s = parseStatus({ BackendState: "Running", Self: { DNSName: "macbook.tail1234.ts.net.", UserID: 7 }, CertDomains: ["macbook.tail1234.ts.net"], CurrentTailnet: { Name: "me@gmail.com", MagicDNSEnabled: true }, User: { 7: { LoginName: "me@gmail.com" } } });
  assert.deepEqual(s, { state: "running", dnsName: "macbook.tail1234.ts.net", tailnet: "me@gmail.com", magicDNS: true, https: true, user: "me@gmail.com" });
  assert.equal(parseStatus({ BackendState: "Running", Self: { DNSName: "m.t.ts.net." } }).https, false, "no CertDomains: HTTPS is off for the tailnet");
  assert.equal(parseStatus({ BackendState: "NeedsLogin" }).state, "signed-out");
  assert.equal(parseStatus("not json").state, "unknown");
});

test("serve commands: HTTPS on the tailnet name to B5 Code's own local port, and off again", () => {
  assert.deepEqual(serveArgs(443, 4321), ["serve", "--bg", "--https=443", "http://127.0.0.1:4321"]);
  assert.deepEqual(serveArgs(8443, 4322, true), ["serve", "--https=8443", "off"]);
  const st = { Web: { "m.t.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4321" } } } } };
  assert.equal(serving(st, "m.t.ts.net", 443, 4321), true);
  assert.equal(serving(st, "m.t.ts.net", 8443, 4322), false);
  assert.equal(serving("{}", "m.t.ts.net", 443, 4321), false);
});

test("a link to allow something in Tailscale's admin console is picked out", () => {
  assert.equal(adminLink("Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc123\n"), "https://login.tailscale.com/f/serve?node=abc123");
  assert.equal(tailnetOrigins("m.t.ts.net").preview, "https://m.t.ts.net:8443");
});
