// The screen check and init, against fixture apps (test/fixtures/, made-up apps with a few files each).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { scan, inspectSuggestEverywhere, checkSuggestEverywhere, checkEntryOnRoutes, checkEntryOnRoutesAsync, exportsOf, UsageError } from "../src/check/index.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fx = (name) => join(ROOT, "test", "fixtures", name);
const run = (bin, args) => spawnSync(process.execPath, [join(ROOT, "bin", bin), ...args], { encoding: "utf8" });
const temp = (name) => { const d = mkdtempSync(join(tmpdir(), "sac-")); cpSync(fx(name), d, { recursive: true }); return d; };

test("a clean app passes, and an exempt screen with a reason is allowed", () => {
  const r = inspectSuggestEverywhere({ repo: fx("green") });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.exempted, [["/share/[token]", "opened by a stranger who is not a member of the pantry"]]);
  assert.deepEqual(checkSuggestEverywhere({ repo: fx("green") }), []);
});

test("a screen with no entry fails", () => {
  const p = checkSuggestEverywhere({ repo: fx("no-entry") });
  assert.equal(p.length, 1);
  assert.match(p[0], /src\/app\/shelf\/page\.tsx: the screen \/shelf has no Suggest a change entry/);
});

test("a missing adapter fails", () => {
  const p = checkSuggestEverywhere({ repo: fx("missing-adapter") });
  assert.deepEqual(p.length, 1);
  assert.match(p[0], /the adapter "limits" is not exported/);
  const none = checkSuggestEverywhere({ repo: fx("no-adapters") });
  assert.match(none.join("\n"), /the adapters file is missing/);
});

test("adapters exported through export * and export { x as y } count", () => {
  assert.deepEqual(checkSuggestEverywhere({ repo: fx("reexported") }), []);
  assert.deepEqual([...exportsOf(join(fx("reexported"), "tailor/suggest-a-change.ts"))].sort(), ["identity", "limits", "store", "words"]);
});

test("an exempt screen needs a reason", () => {
  const p = checkSuggestEverywhere({ repo: fx("exempt-no-reason") });
  assert.ok(p.some((x) => /the screen \/share is exempt from Suggest a change with no reason/.test(x)), p.join("\n"));
  assert.ok(p.some((x) => /\/gone is exempt .* there is no screen at \/gone/.test(x)), "a stale exemption is a problem too");
});

test("a nested layout, reached through a shell component and a route group, covers its pages", () => {
  assert.deepEqual(checkSuggestEverywhere({ repo: fx("nested-ok") }), []);
});

test("only the pages under a layout that renders the entry are covered", () => {
  const p = checkSuggestEverywhere({ repo: fx("bare-nested") });
  assert.equal(p.length, 2, p.join("\n"));
  assert.ok(p.every((x) => /\/plain/.test(x)) && p.some((x) => /\/plain\/deeper/.test(x)), p.join("\n"));
});

test("naming the entry in a comment or an import is not rendering it", () => {
  const p = checkSuggestEverywhere({ repo: fx("not-rendered") });
  assert.equal(p.length, 1);
  assert.match(p[0], /\/shelf/);
});

test("the check reads the same screen list as the home-screen check: home routes and underscore folders are skipped", () => {
  const d = temp("no-entry");
  writeFileSync(join(d, "home-screen.json"), JSON.stringify({ home: ["/", "/shelf"] }));
  assert.deepEqual(checkSuggestEverywhere({ repo: d }), []);
  rmSync(d, { recursive: true });
});

test("an app with nothing to check is a usage error, not a pass", () => {
  assert.throws(() => checkSuggestEverywhere({ repo: join(fx("green"), "tailor") }), UsageError);
});

test("checkEntryOnRoutes renders each route and looks for data-suggest-entry", async () => {
  const pages = { "/a": '<main><button data-suggest-entry="">Suggest a change</button></main>', "/b": "<main>nothing</main>" };
  const render = (r) => pages[r];
  assert.deepEqual(checkEntryOnRoutes({ routes: ["/a"], render }), []);
  const p = checkEntryOnRoutes({ routes: ["/a", "/b"], render });
  assert.equal(p.length, 1);
  assert.match(p[0], /route \/b: renders without the Suggest a change entry/);
  assert.match(checkEntryOnRoutes({ routes: [], render })[0], /no routes/);
  assert.match(checkEntryOnRoutes({ routes: [{ route: "/b", exempt: " " }], render })[0], /no reason/);
  assert.deepEqual(checkEntryOnRoutes({ routes: [{ route: "/b", exempt: "a printed page" }], render }), []);
  assert.match(checkEntryOnRoutes({ routes: ["/c"], render: () => { throw new Error("boom"); } })[0], /could not be rendered \(boom\)/);
  assert.deepEqual(await checkEntryOnRoutesAsync({ routes: ["/a"], render: async (r) => pages[r] }), []);
  assert.equal((await checkEntryOnRoutesAsync({ routes: ["/b"], render: async (r) => pages[r] })).length, 1);
});

test("the command: exit 0 clean, 1 problems, 2 usage, with --json and --help", () => {
  const ok = run("check.mjs", ["--repo", fx("green")]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Suggest a change holds/);
  const bad = run("check.mjs", ["--repo", fx("no-entry")]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /the screen \/shelf has no Suggest a change entry/);
  const json = JSON.parse(run("check.mjs", ["--repo", fx("no-entry"), "--json"]).stdout);
  assert.equal(json.ok, false);
  assert.equal(json.problems.length, 1);
  assert.equal(run("check.mjs", ["--bogus"]).status, 2);
  assert.equal(run("check.mjs", ["--repo", "/nonexistent-sac-folder"]).status, 2);
  assert.equal(run("check.mjs", ["--repo", fx("green"), "--config", "nope.json"]).status, 2);
  const help = run("check.mjs", ["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: suggest-a-change-check/);
  // the same command through the main bin
  assert.equal(run("suggest-a-change.mjs", ["check", "--repo", fx("no-entry")]).status, 1);
  assert.equal(run("suggest-a-change.mjs", ["nonsense"]).status, 2);
  assert.equal(run("suggest-a-change.mjs", ["--help"]).status, 0);
});

test("init on a fixture app makes the check green", () => {
  const d = temp("init-app");
  assert.equal(run("check.mjs", ["--repo", d]).status, 1, "the unwired fixture starts red");
  const r = run("init.mjs", ["--repo", d, "--owner", "Sam"]);
  assert.equal(r.status, 0, r.stderr);
  const after = run("check.mjs", ["--repo", d]);
  assert.equal(after.status, 0, after.stdout + after.stderr);
  const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf8"));
  assert.match(pkg.dependencies["@supersuit/suggest-a-change"], /^\^0\.1\./);
  assert.equal(pkg.scripts.check, "tsc --noEmit && suggest-a-change-check");
  assert.ok(existsSync(join(d, "tailor/suggest-a-change.ts")));
  const stub = readFileSync(join(d, "tailor/suggest-a-change.ts"), "utf8");
  assert.match(stub, /app: "pantry", owner: "Sam"/);
  assert.match(readFileSync(join(d, "src/app/layout.tsx"), "utf8"), /<SuggestChange \/>\{children\}/);
  rmSync(d, { recursive: true });
});

test("init names tellSubmitter: the stub carries it and the notes say the server half needs it", () => {
  const d = temp("init-app");
  const r = run("init.mjs", ["--repo", d, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const log = JSON.parse(r.stdout);
  assert.match(log.notes.join("\n"), /tellSubmitter/);
  assert.match(log.notes.join("\n"), /\{ none: "<reason>" \}/);
  assert.match(readFileSync(join(d, "tailor/suggest-a-change.ts"), "utf8"), /export const tellSubmitter/);
  // an adapters file of the app's own that has no tellSubmitter is reminded too
  writeFileSync(join(d, "tailor/suggest-a-change.ts"), "export const identity = 1; export const store = 2; export const words = 3; export const limits = 4;\n");
  const again = JSON.parse(run("init.mjs", ["--repo", d, "--json"]).stdout);
  assert.match(again.notes.join("\n"), /tellSubmitter/);
  rmSync(d, { recursive: true });
});

test("init is idempotent and never overwrites an adapters file", () => {
  const d = temp("init-app");
  run("init.mjs", ["--repo", d]);
  const files = ["package.json", "tailor/suggest-a-change.ts", "src/app/layout.tsx", "src/components/suggest-a-change.tsx"];
  const first = files.map((f) => readFileSync(join(d, f), "utf8"));
  const again = run("init.mjs", ["--repo", d]);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /already wired; nothing changed/);
  assert.deepEqual(files.map((f) => readFileSync(join(d, f), "utf8")), first);
  writeFileSync(join(d, "tailor/suggest-a-change.ts"), "// mine\nexport const identity = 1; export const store = 2; export const words = 3; export const limits = 4;\n");
  run("init.mjs", ["--repo", d, "--owner", "Other"]);
  assert.match(readFileSync(join(d, "tailor/suggest-a-change.ts"), "utf8"), /^\/\/ mine/);
  rmSync(d, { recursive: true });
});

test("init refuses what it does not understand (exit 2) and prefers the living:check script", () => {
  assert.equal(run("init.mjs", ["--repo", join(fx("green"), "tailor")]).status, 2);
  assert.equal(run("init.mjs", ["--wat"]).status, 2);
  const d = temp("init-app");
  const pkgPath = join(d, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.scripts["living:check"] = "node living/a.mjs";
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  run("init.mjs", ["--repo", d]);
  const out = JSON.parse(readFileSync(pkgPath, "utf8"));
  assert.equal(out["scripts"]["living:check"], "node living/a.mjs && suggest-a-change-check");
  assert.equal(out.scripts.check, "tsc --noEmit");
  rmSync(d, { recursive: true });
});

test("a layout that imports a shell and never renders it does not cover its pages", () => {
  const p = checkSuggestEverywhere({ repo: fx("unused-shell") });
  assert.equal(p.length, 1, p.join("\n"));
  assert.match(p[0], /the screen \/shelf has no Suggest a change entry/);
});

test("an entry after an apostrophe in JSX text is found", () => {
  assert.deepEqual(checkSuggestEverywhere({ repo: fx("apostrophe") }), []);
});

test("naming the entry only inside a string literal does not count", () => {
  const p = checkSuggestEverywhere({ repo: fx("entry-in-string") });
  assert.equal(p.length, 1, p.join("\n"));
  assert.match(p[0], /\/shelf/);
});

test("the scanner knows strings from JSX text", () => {
  const s = scan(`const a = "<Fake />"; const b = <p>It's {/* it's */}<Real data-x="<Nope />" y={'<Str />'} />, don't</p>;`);
  assert.deepEqual([...s.elements].sort(), ["Real", "p"]);
  assert.deepEqual([...s.attrs].sort(), ["data-x", "y"]);
  assert.ok(!s.code.includes("Fake") && !s.code.includes("Str"));
  assert.deepEqual([...scan("const x: Array<string> = []; if (a < b) { return <A.B/> }").elements], ["A.B"]);
});

test("an app directory with no pages is a usage error: nothing was checked", () => {
  assert.throws(() => checkSuggestEverywhere({ repo: fx("empty-app") }), (e) => e instanceof UsageError && /nothing was checked/.test(e.message));
  const r = run("check.mjs", ["--repo", fx("empty-app")]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /nothing was checked/);
});

test("an app directory outside the repo is refused", () => {
  assert.throws(() => checkSuggestEverywhere({ repo: fx("green"), appDir: "../no-entry/src/app" }), UsageError);
  assert.equal(run("check.mjs", ["--repo", fx("green"), "--app-dir", "/tmp"]).status, 2);
});

// DRIFT GUARD. The module copies the screen-list rules of a template's living/home-screen-contract.mjs
// (README: "The screen list"). This pins them on a fixture: if either side changes, the list changes. The
// expected list below is what the template's routeOf produced for the same tree when it was written.
test("the screen list follows the rules the home-screen check follows", () => {
  const r = inspectSuggestEverywhere({ repo: fx("routes") });
  assert.deepEqual(r.problems, []);
  assert.deepEqual([...r.checked].sort(), [
    "/about", // route group (marketing) dropped
    "/docs", // page.mdx
    "/docs/[...slug]", // catch-all
    "/feed/(..)photos/[id]", // intercepting folders are NOT dropped: only (name) folders that end in ")" are groups
    "/guide", // page.jsx
    "/legacy", // page.js
    "/photos",
    "/photos/(.)view/[id]", // intercepting, kept as a segment
    "/posts/[id]", // dynamic segment
    "/shop/[[...path]]", // optional catch-all
    "/stats", // @sidebar slot dropped
    "/team", // nested groups (marketing)/(deep) dropped
    "/typed", // page.ts
  ]);
  // not screens: "/" (home), _private and blog/_drafts (underscore folders), page.test.tsx, page.dev.tsx, route.ts
});

test("a stub from init is a warning, and a problem under --strict", () => {
  const d = temp("init-app");
  const r = run("init.mjs", ["--repo", d]);
  assert.match(r.stdout, /note: the adapters in tailor\/suggest-a-change.ts are stubs/);
  const plain = run("check.mjs", ["--repo", d]);
  assert.equal(plain.status, 0, plain.stdout);
  assert.match(plain.stdout, /warning: tailor\/suggest-a-change.ts: still the stub/);
  assert.equal(JSON.parse(run("check.mjs", ["--repo", d, "--json"]).stdout).warnings.length, 1);
  const strict = run("check.mjs", ["--repo", d, "--strict"]);
  assert.equal(strict.status, 1);
  assert.match(strict.stdout, /still the stub/);
  const f = join(d, "tailor/suggest-a-change.ts");
  writeFileSync(f, readFileSync(f, "utf8").split("\n").filter((l) => !l.includes("suggest-a-change: STUB")).join("\n"));
  assert.equal(run("check.mjs", ["--repo", d, "--strict"]).status, 0);
  rmSync(d, { recursive: true });
});

test("init keeps the package's indent and key order, and finds the JSX children", () => {
  const d = temp("init-app");
  const pkgPath = join(d, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.dependencies = { react: "^19.0.0", next: "^16.0.0" }; // deliberately not sorted
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 4) + "\n");
  writeFileSync(join(d, "src/app/layout.tsx"), "import type { ReactNode } from 'react'\nexport default function L({children}: {children: ReactNode}) {\n  return <html><body>{children}</body></html>\n}\n");
  run("init.mjs", ["--repo", d]);
  const raw = readFileSync(pkgPath, "utf8");
  assert.match(raw, /^\{\n    "name"/);
  assert.deepEqual(Object.keys(JSON.parse(raw).dependencies), ["react", "next", "@supersuit/suggest-a-change"]);
  const layout = readFileSync(join(d, "src/app/layout.tsx"), "utf8");
  assert.match(layout, /function L\(\{children\}: /);
  assert.match(layout, /<body><SuggestChange \/>\{children\}<\/body>/);
  assert.equal(run("check.mjs", ["--repo", d]).status, 0);
  rmSync(d, { recursive: true });
});

test("init refuses an app directory outside the repo", () => {
  const d = temp("init-app");
  writeFileSync(join(d, "home-screen.json"), JSON.stringify({ home: ["/"], appDir: "../elsewhere" }));
  assert.equal(run("init.mjs", ["--repo", d]).status, 2);
  rmSync(d, { recursive: true });
});

test("a barrel that also re-exports the shell does not cover a layout that renders only its Button", () => {
  const p = checkSuggestEverywhere({ repo: fx("barrel-false-green") });
  assert.equal(p.length, 2, p.join("\n")); // /shelf through a named barrel, /starred through an export * barrel
  assert.ok(p.some((x) => /the screen \/shelf has no/.test(x)) && p.some((x) => /the screen \/starred has no/.test(x)));
});

test("a name carried through import-then-export, export default, renamed and star re-exports still reaches the entry", () => {
  const r = inspectSuggestEverywhere({ repo: fx("barrel-ok") });
  assert.deepEqual(r.problems, []);
  assert.equal(r.checked.length, 6);
});

test("a shell passed as a prop value or through a const alias counts as rendered", () => {
  assert.deepEqual(checkSuggestEverywhere({ repo: fx("shell-as-value") }), []);
});

test("a TSX generic arrow is not read as a JSX element", () => {
  const s = scan("const f = <T,>(x: T) => x;\nconst g = <U extends object>(x: U) => <SuggestEntry />;\nconst h = <const V extends string>(v: V) => v;\nexport default function L() { return <p>{f(1)}<b/></p>; }");
  assert.deepEqual([...s.elements].sort(), ["SuggestEntry", "b", "p"]);
});

test("init accepts an app directory that is the repo root", () => {
  const d = mkdtempSync(join(tmpdir(), "sac-root-"));
  writeFileSync(join(d, "package.json"), JSON.stringify({ name: "rootapp", scripts: { check: "true" } }));
  writeFileSync(join(d, "home-screen.json"), JSON.stringify({ home: ["/"], appDir: "." }));
  writeFileSync(join(d, "layout.tsx"), "export default function L({ children }) {\n  return <html><body>{children}</body></html>\n}\n");
  writeFileSync(join(d, "page.tsx"), "export default function P() { return <main>Home</main> }\n");
  mkdirSync(join(d, "shelf"));
  writeFileSync(join(d, "shelf/page.tsx"), "export default function P() { return <main>Shelf</main> }\n");
  const r = run("init.mjs", ["--repo", d]);
  assert.equal(r.status, 0, r.stderr);
  const c = run("check.mjs", ["--repo", d]);
  assert.equal(c.status, 0, c.stdout + c.stderr);
  rmSync(d, { recursive: true });
});

test("a namespace import is narrowed to the member that is rendered", () => {
  const p = checkSuggestEverywhere({ repo: fx("namespace") });
  assert.equal(p.length, 1, p.join("\n"));
  assert.match(p[0], /the screen \/button has no Suggest a change entry/); // <ui.Button /> does not reach the shell
  // <ui.Shell /> (/shell) passes, and so does handing the whole namespace on as a value (/whole)
});

test("a file first reached with no depth left is judged again when a shorter path reaches it", () => {
  assert.deepEqual(checkSuggestEverywhere({ repo: fx("depth-order") }), []);
});

test("the check does not import react or the client", () => {
  for (const f of ["index.mjs", "cli.mjs", "init.mjs", "args.mjs"]) {
    // init.mjs holds the text of generated files, which do import react; only its own imports count.
    const src = readFileSync(join(ROOT, "src/check", f), "utf8").split("const stubFor")[0];
    assert.ok(!/from ["'](react|react-dom|\.\.\/client)/.test(src), `${f} imports react or the client`);
  }
});
