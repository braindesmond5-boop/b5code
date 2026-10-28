import { test } from "node:test";
import assert from "node:assert/strict";
import { altNames, permittedIp, NAME_CONSTRAINTS } from "../server/tls.js";

test("the certificate names only addresses its authority may vouch for", () => {
  assert.deepEqual(altNames(["192.168.1.5", "100.105.91.107", "169.254.12.3", "8.8.8.8", "192.168.1.5"], "Mac's Air"),
    ["IP:100.105.91.107", "IP:192.168.1.5", "DNS:Mac-s-Air.local", "DNS:localhost", "IP:127.0.0.1"],
    "a self-assigned or public address would make phones refuse the whole certificate");
  for (const ip of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.0.1", "100.64.0.1", "100.127.255.255", "127.0.0.1"]) assert.ok(permittedIp(ip), ip);
  for (const ip of ["172.32.0.1", "100.128.0.1", "169.254.1.1", "8.8.8.8", "fe80::1", "nope"]) assert.ok(!permittedIp(ip), ip);
  assert.match(NAME_CONSTRAINTS, /^permitted;IP:10\.0\.0\.0\/255\.0\.0\.0, .*permitted;DNS:local, permitted;DNS:localhost$/);
});
