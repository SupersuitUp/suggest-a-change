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

// Every file path an export (including each condition of a conditional export) or a bin points at.
function targets() {
  const out = [];
  const walk = (name, v) => (typeof v === "string" ? out.push([name, v]) : Object.entries(v).forEach(([c, t]) => walk(`${name}[${c}]`, t)));
  for (const [k, v] of Object.entries(pkg.exports)) walk(`export ${k}`, v);
  for (const [k, v] of Object.entries(pkg.bin)) walk(`bin ${k}`, v);
  return out;
}

// "./client" points into dist/, which `npm run build` makes, so this test runs after the build.
test("every export and bin target exists", () => {
  for (const [name, v] of targets()) assert.ok(existsSync(join(ROOT, v)), `${name} -> ${v} does not exist (run npm run build)`);
});

test("the published file list covers every export and bin target", () => {
  const covers = (path) => pkg.files.some((f) => { const p = f.replace(/^\.\//, ""); return path.replace(/^\.\//, "") === p || (p.endsWith("/") && path.replace(/^\.\//, "").startsWith(p)); });
  for (const [name, v] of targets()) {
    if (v === "./package.json") continue; // npm always ships package.json
    assert.ok(covers(v), `${name} -> ${v} is not covered by "files", so it would not be published`);
  }
});

test('"./client" ships types and ESM', () => {
  assert.deepEqual(Object.keys(pkg.exports["./client"]).sort(), ["import", "types"]);
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

test("the README documents every --sac- custom property the stylesheet reads", () => {
  const css = readFileSync(join(ROOT, pkg.exports["./styles.css"]), "utf8");
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const used = new Set(css.match(/--sac-[a-z-]+/g));
  assert.ok(used.size >= 10);
  for (const v of used) assert.ok(readme.includes(`\`${v}\``), `${v} is used by styles.css but not documented in the README`);
});
