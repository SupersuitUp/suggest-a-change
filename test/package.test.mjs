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

// Next.js hosts fail when a server file imports a module that uses React hooks without the directive. The
// build must keep "use client" as the first statement of every emitted file that imports react.
import { readdirSync } from "node:fs";
test('every built client file that imports react starts with "use client"', () => {
  const dir = join(ROOT, "dist", "client");
  let checked = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".js"))) {
    const src = readFileSync(join(dir, f), "utf8");
    if (!/from ["']react(\/jsx-runtime)?["']/.test(src)) continue;
    checked++;
    assert.match(src, /^(\/\/[^\n]*\n|\s)*["']use client["'];?/, `${f} imports react but does not start with "use client"`);
  }
  assert.ok(checked >= 8, `only ${checked} react files found in dist/client`);
});

test("no real person's first name appears in the repo's text files", async () => {
  // SHA-256 digests of lowercase names that must never appear in this public repo. The names themselves are
  // deliberately not written down here; every lowercase word in every text file is hashed and compared.
  const { createHash } = await import("node:crypto");
  const NEVER = new Set([
    "21dfc18dd04cd6a356e2f1e36e8285bc060a5d589d3ac707e56ac9654903b589",
    "919e680ee460849a74a82614de062bfbbac76bc98a2f692952b5fcb6364e598b",
    "43a0f8aad9d45805f56400d137abe21f19861e5d0523ecfdfcff41a8203986b2",
  ]);
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.name === "node_modules" || e.name === ".git" || e.name === "dist" ? [] : e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
  const seen = new Map();
  for (const f of walk(ROOT).filter((p) => /\.(ts|tsx|mjs|md|json|css|yml)$/.test(p) && !p.endsWith("package-lock.json"))) {
    for (const w of new Set(readFileSync(f, "utf8").toLowerCase().match(/[a-z]+/g) ?? [])) {
      if (!seen.has(w)) seen.set(w, createHash("sha256").update(w).digest("hex"));
      assert.ok(!NEVER.has(seen.get(w)), `${f} contains a name that must not appear in this repo`);
    }
  }
  assert.ok(seen.size > 500);
});

test('"./check" and the suggest-a-change-check command are exported, and a scoped package publishes public', () => {
  assert.equal(pkg.exports["./check"], "./src/check/index.mjs");
  assert.equal(pkg.bin["suggest-a-change-check"], "bin/check.mjs");
  assert.equal(pkg.publishConfig.access, "public");
});

test('"./server" ships types and ESM, and imports nothing from react, the client or any package', () => {
  assert.deepEqual(Object.keys(pkg.exports["./server"]).sort(), ["import", "types"]);
  const dir = join(ROOT, "dist", "server");
  let checked = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".js"))) {
    checked++;
    const src = readFileSync(join(dir, f), "utf8");
    // Every import specifier must be relative (the contract and sibling server files): no package, no node: module.
    for (const m of src.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)) {
      assert.ok(m[1].startsWith("./") || m[1].startsWith("../"), `dist/server/${f} imports ${m[1]}`);
      assert.ok(!/client|react/.test(m[1]), `dist/server/${f} reaches the client or react through ${m[1]}`);
    }
  }
  assert.ok(checked >= 5, `only ${checked} files in dist/server`);
});

test('"./github" ships types and ESM, imports nothing from react, the client or any package, and works without react', async () => {
  assert.deepEqual(pkg.exports["./github"], { types: "./dist/github/index.d.ts", import: "./dist/github/index.js" });
  const dir = join(ROOT, "dist", "github");
  let checked = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".js"))) {
    checked++;
    const src = readFileSync(join(dir, f), "utf8");
    for (const m of src.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)) {
      assert.ok(m[1].startsWith("./") || m[1].startsWith("../"), `dist/github/${f} imports ${m[1]}`);
      assert.ok(!/client|react/.test(m[1]), `dist/github/${f} reaches the client or react through ${m[1]}`);
    }
  }
  assert.ok(checked >= 5, `only ${checked} files in dist/github`);
  const mod = await import(join(ROOT, "dist", "github", "index.js"));
  for (const name of ["privacyCatch", "redact", "mayFileAsIs", "composeIssue", "whatGoes", "fileIssue", "updateIssue", "addFollowUp", "issueStates", "issueStatus", "fileSuggestion", "attachPending", "branchHost", "relayHost", "createAttachRelay", "createSuggestionRelay", "relayFiler", "canFileDirectly", "memoryUsage"]) assert.equal(typeof mod[name], "function", name);
});

test("the version is 0.2.0 and the changelog says why", () => {
  assert.equal(pkg.version, "0.2.0");
  assert.match(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"), /^## 0\.2\.0 \(/m);
});

test("importing the server entry needs no react", async () => {
  const mod = await import(join(ROOT, "dist", "server", "index.js"));
  for (const name of ["createReportHandlers", "runStoreConformance", "sniffType"]) assert.equal(typeof mod[name], "function", name);
});

// The suggestion news toast drew a full-width bar over the top of the host's page on open. Toasts sit small at the
// bottom edge instead, as wide as their words.
test("toasts sit small at the bottom, never over the top of the host's page", () => {
  const css = readFileSync(join(ROOT, "src", "client", "styles.css"), "utf8");
  const rule = (sel) => (css.match(new RegExp(`^\\${sel} \\{([^}]*)\\}`, "m")) || [])[1] || "";
  const host = rule(".sac-toasts");
  const pill = rule(".sac-toast");
  assert.match(host, /\bbottom:/, ".sac-toasts must anchor to the bottom");
  assert.doesNotMatch(host, /\btop:/, ".sac-toasts must not anchor to the top");
  assert.doesNotMatch(pill, /\bwidth:\s*100%/, ".sac-toast must be as wide as its words, not full width");
  assert.match(css, /\.sac-toast::after \{[^}]*content:/, ".sac-toast draws a dismiss mark");
});
