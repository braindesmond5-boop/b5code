import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// PowerShell ignores case: a function called Winget IS the command `winget`, so `winget install` inside it
// called itself until "call depth overflow", on the very step that installs Node.js.
test("the Windows installer's own functions never share a name with a program it runs", () => {
  const script = fs.readFileSync(new URL("../windows/install.ps1", import.meta.url), "utf8");
  const functions = [...script.matchAll(/^\s*function\s+([\w-]+)/gim)].map((m) => m[1].toLowerCase());
  const programs = ["winget", "git", "node", "npm", "claude", "powershell", "pwsh", "irm", "iex"];
  assert.ok(functions.length >= 4, "found its functions");
  for (const f of functions) assert.equal(programs.includes(f), false, `function ${f} shadows the program of the same name`);
});
