// The package must not promise what it does not ship: every export and bin target exists, and the
// published file list covers them. Exports for "./client", "./server" and "./check" are added when
// their code lands, never before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

test("every export and bin target exists", () => {
  for (const [k, v] of Object.entries(pkg.exports)) assert.ok(existsSync(join(ROOT, v)), `export ${k} -> ${v} does not exist`);
  for (const [k, v] of Object.entries(pkg.bin)) assert.ok(existsSync(join(ROOT, v)), `bin ${k} -> ${v} does not exist`);
});

test('the "." export is the contract and the package has no runtime dependencies', () => {
  assert.equal(pkg.exports["."], "./src/contract.mjs");
  assert.deepEqual(pkg.dependencies, {});
});

test("react is an optional peer, so the contract installs without it", () => {
  for (const name of ["react", "react-dom"]) {
    assert.equal(pkg.peerDependencies[name], "^19");
    assert.equal(pkg.peerDependenciesMeta[name].optional, true);
  }
});
