// HTTPS for phone access. B5 Code is its own small certificate authority:
// it makes one authority for this Mac (once), and from it a certificate for
// the addresses the Mac has on your network (again whenever they change).
// A phone shows a warning the first time, or none at all once the
// authority's certificate is installed on it (Settings on the Mac links it).
//
// macOS ships LibreSSL 2.8, which has no -addext, so extensions go through
// a config file. Keys stay in data/tls, readable only by you.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { IS_WIN, findProgram, programFiles } from "./platform.js";

// iPhones refuse server certificates valid for more than 825 days.
const LEAF_DAYS = 800;
const CA_DAYS = 3650;

/**
 * The names a certificate must cover: each private network address, and this Mac's .local
 * name. Only addresses the authority may vouch for (NAME_CONSTRAINTS): one outside them (a
 * self-assigned 169.254 address, a public one) would make phones refuse the whole certificate.
 */
export function altNames(ips, hostname) {
  const host = String(hostname || "").replace(/\.local$/i, "").replace(/[^A-Za-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  return [...new Set(ips)].filter(permittedIp).sort().map((ip) => `IP:${ip}`).concat(host ? [`DNS:${host}.local`] : []).concat(["DNS:localhost", "IP:127.0.0.1"]);
}

// The ranges in NAME_CONSTRAINTS, as [network, mask]: the same list, so the two can't drift apart.
const PERMITTED = [["10.0.0.0", "255.0.0.0"], ["172.16.0.0", "255.240.0.0"], ["192.168.0.0", "255.255.0.0"], ["100.64.0.0", "255.192.0.0"], ["127.0.0.0", "255.0.0.0"]];
const ipNum = (ip) => String(ip).split(".").reduce((n, o) => n * 256 + Number(o), 0);
function PERMITTED_RANGES() { return PERMITTED.map(([n, m]) => `${n}/${m}`); }
export function permittedIp(ip) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip))) return false;
  return PERMITTED.some(([net, mask]) => ((ipNum(ip) & ipNum(mask)) >>> 0) === ipNum(net));
}

// What the authority may vouch for: private addresses (home networks, Tailscale's 100.64/10, loopback) and .local names.
export const NAME_CONSTRAINTS = PERMITTED_RANGES()
  .map((r) => `permitted;IP:${r}`).concat(["permitted;DNS:local", "permitted;DNS:localhost"]).join(", ");

/** The openssl config for the authority and for the server certificate. */
export function opensslConfig(names) {
  return [
    // The names themselves come from -subj (LibreSSL lets a [dn] here win over it).
    "[req]", "distinguished_name = dn", "[dn]",
    // Name constraints: the authority can only vouch for home-network addresses and .local names, so its
    // key, if ever stolen, can't impersonate any real website to a phone that trusts it.
    "[ca]", "basicConstraints = critical, CA:TRUE, pathlen:0", "keyUsage = critical, keyCertSign, cRLSign", "subjectKeyIdentifier = hash",
    `nameConstraints = critical, ${NAME_CONSTRAINTS}`,
    "[leaf]", "basicConstraints = critical, CA:FALSE", "keyUsage = critical, digitalSignature, keyEncipherment", "extendedKeyUsage = serverAuth",
    `subjectAltName = ${names.join(", ")}`, "subjectKeyIdentifier = hash", "authorityKeyIdentifier = keyid",
    "",
  ].join("\n");
}

function openssl(args, cwd) {
  return new Promise((resolve, reject) => {
    // Windows has none of its own: Git for Windows brings one.
    const bin = IS_WIN ? findProgram("openssl", [programFiles("Git\\usr\\bin\\openssl.exe"), programFiles("Git\\mingw64\\bin\\openssl.exe")]) || "openssl" : "openssl";
    execFile(bin, args, { cwd, timeout: 30000, windowsHide: true }, (err, out, errOut) => (err ? reject(new Error(`openssl: ${(errOut || err.message).trim().split("\n").pop()}`)) : resolve(out)));
  });
}

/**
 * The key and certificate for phone access, made or remade as needed.
 * Returns { key, cert, ca } (PEM strings).
 */
export async function ensureCertificate(dir, ips, hostname = os.hostname()) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = (f) => path.join(dir, f);
  const names = altNames(ips, hostname);
  fs.writeFileSync(file("openssl.cnf"), opensslConfig(names));

  // An authority made before name constraints is replaced, and its key destroyed.
  if (fs.existsSync(file("ca.crt")) && !(await openssl(["x509", "-in", "ca.crt", "-noout", "-text"], dir).catch(() => "")).includes("Name Constraints")) {
    for (const f of ["ca.key", "ca.crt", "ca.srl", "server.crt", "server.key", "server.names"]) fs.rmSync(file(f), { force: true });
  }
  if (!fs.existsSync(file("ca.key")) || !fs.existsSync(file("ca.crt"))) {
    const label = `B5 Code on ${String(hostname).replace(/\.local$/i, "")}`.replace(/[/=]/g, "-");
    await openssl(["req", "-x509", "-new", "-nodes", "-newkey", "rsa:2048", "-sha256", "-days", String(CA_DAYS),
      "-keyout", "ca.key", "-out", "ca.crt", "-subj", `/CN=${label}/O=B5 Code`, "-config", "openssl.cnf", "-extensions", "ca"], dir);
    fs.rmSync(file("server.crt"), { force: true }); // a new authority: the old certificate is no good
  }

  // The server certificate covers today's addresses; a new network means a new one.
  const have = fs.existsSync(file("server.crt")) && fs.existsSync(file("server.names")) ? fs.readFileSync(file("server.names"), "utf8") : "";
  const fresh = fs.existsSync(file("server.crt")) && Date.now() - fs.statSync(file("server.crt")).mtimeMs < (LEAF_DAYS - 30) * 86400000;
  if (have !== names.join(",") || !fresh) {
    await openssl(["req", "-new", "-nodes", "-newkey", "rsa:2048", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=B5 Code server/O=B5 Code", "-config", "openssl.cnf"], dir);
    await openssl(["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-sha256", "-days", String(LEAF_DAYS),
      "-out", "server.crt", "-extfile", "openssl.cnf", "-extensions", "leaf"], dir);
    fs.writeFileSync(file("server.names"), names.join(","));
    fs.rmSync(file("server.csr"), { force: true });
  }
  for (const f of ["ca.key", "server.key"]) fs.chmodSync(file(f), 0o600);
  return { key: fs.readFileSync(file("server.key"), "utf8"), cert: fs.readFileSync(file("server.crt"), "utf8"), ca: fs.readFileSync(file("ca.crt"), "utf8") };
}
