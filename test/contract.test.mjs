// test/contract.test.mjs
// THE REPORT CONTRACT AND THE FLOW MAP (suggest-a-change design sections 4, 5 and 7). These
// tests hold the contract to having no imports at all, so it can be vendored whole.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const C = await import(join(ROOT, "src/contract.mjs"));

const good = (o = {}) => ({
  id: "r-20261012174500-abc123",
  app: { name: "Notes", template: "example/notes", templateVersion: "1.2.0", copy: "alex" },
  who: { member: "alex", role: "operator" },
  kind: "change",
  words: "the photos are small",
  voice: [{ file: "v1.m4a", ms: 20_000 }],
  media: [{ file: "a.png", type: "image/png", bytes: 1000, sha256: "ab".repeat(32) }],
  where: { screen: "Photos", route: "/photos" },
  diagnostics: { appVersion: "1.2.0", at: "2026-10-12T17:45:00Z", device: "iPhone", screen: "390x844" },
  timeline: [{ status: "on-phone", by: "person", at: "2026-10-12T17:45:00Z" }],
  ...o,
});

test("the contract file has no imports, so it can be lifted whole", () => {
  const src = readFileSync(join(ROOT, "src/contract.mjs"), "utf8");
  assert.doesNotMatch(src, /^\s*import\s|\bimport\s*\(|\brequire\s*\(/m);
});

test("the status list is GitHub's, in order", () => {
  assert.deepEqual(C.STATUSES, ["on-phone", "received", "held", "open", "done", "not-planned"]);
  assert.deepEqual(C.END, ["done", "not-planned"]);
  assert.deepEqual(C.TOLD, ["open", "done", "not-planned"]);
  assert.deepEqual(C.KINDS, ["change", "broken", "feedback"]);
  assert.deepEqual(C.ROLES, ["operator", "member", "maintainer"]);
});

test("every status has an actor and a next step; a closed issue can only be reopened", () => {
  for (const s of C.STATUSES) {
    const f = C.FLOW[s];
    assert.ok(["person", "app", "mac", "owner", "github"].includes(f.actor), `${s} has no actor`);
    assert.ok(f.next.length >= 1, `${s} goes nowhere`);
    for (const n of f.next) assert.ok(C.STATUSES.includes(n), `${s} -> ${n} is not a status`);
    if (C.END.includes(s)) assert.deepEqual(f.next, ["open"], `${s} only reopens`);
  }
  const actors = Object.fromEntries(C.STATUSES.map((s) => [s, C.FLOW[s].actor]));
  assert.deepEqual(actors, { "on-phone": "person", "received": "app", "held": "owner", "open": "mac", "done": "github", "not-planned": "github" });
});

test("the flow is the design's", () => {
  const next = Object.fromEntries(C.STATUSES.map((s) => [s, C.FLOW[s].next]));
  assert.deepEqual(next, {
    "on-phone": ["received", "held", "open"],
    "received": ["held", "open", "not-planned"],
    "held": ["open", "not-planned"],
    "open": ["done", "not-planned"],
    "done": ["open"],
    "not-planned": ["open"],
  });
  assert.equal(C.mayMove("received", "done"), false); // an issue is open before it is done
  assert.equal(C.mayMove("held", "done"), false);
  assert.equal(C.mayMove("done", "open"), true); // GitHub reopen
  assert.equal(C.mayMove("nonsense", "open"), false);
});

test("an old status is still readable: it folds into the new one it now means", () => {
  for (const s of ["with-freeda", "planned", "waiting-on-owner", "being-made"]) assert.equal(C.currentStatus(s), "received", s);
  for (const s of ["live", "sent-to-template", "filed"]) assert.equal(C.currentStatus(s), "done", s);
  assert.equal(C.currentStatus("not-now"), "not-planned");
  for (const s of C.STATUSES) assert.equal(C.currentStatus(s), s);
  assert.equal(C.currentStatus("bogus"), "bogus");
  assert.deepEqual(Object.keys(C.LEGACY).sort(), ["being-made", "filed", "live", "not-now", "planned", "sent-to-template", "waiting-on-owner", "with-freeda"]);
  // the Mac may file a report an old pipeline left mid-way, and reopen an old ended one
  assert.equal(C.mayMove("with-freeda", "open"), true);
  assert.equal(C.mayMove("being-made", "held"), true);
  assert.equal(C.mayMove("live", "open"), true);
  assert.equal(C.wordsFor("live", { owner: "Alex" }), "Done");
  assert.equal(C.wordsFor("not-now", { owner: "Alex" }), "Not planned");
  assert.equal(C.wordsFor("with-freeda", { owner: "Alex" }), "Received");
});

test("wordsFor carries the design's table, with the owner's name and the issue number", () => {
  const w = (s) => C.wordsFor(s, { owner: "Alex" });
  assert.equal(w("on-phone"), "On this phone");
  assert.equal(w("received"), "Received");
  assert.equal(w("held"), "Waiting on Alex");
  assert.equal(C.wordsFor("held", { owner: "Sam" }), "Waiting on Sam");
  assert.equal(w("open"), "Open");
  assert.equal(w("done"), "Done");
  assert.equal(w("not-planned"), "Not planned");
  assert.equal(C.meaningFor("open", { owner: "Alex", issue: { number: 123 } }), "Filed as issue #123");
  assert.equal(C.meaningFor("open", { owner: "Alex" }), "Filed as an issue");
  assert.match(C.meaningFor("held", { owner: "Alex" }), /Alex/);
  assert.throws(() => C.wordsFor("bogus", { owner: "Alex" }), /not a status/);
});

test("a report may carry the issue it became, and its shape is checked", () => {
  const issue = { repo: "acme/notes", number: 12, url: "https://github.com/acme/notes/issues/12" };
  assert.deepEqual(C.validateReport(good({ issue })), []);
  assert.deepEqual(C.validIssue(issue), []);
  for (const bad of [
    { ...issue, repo: "notes" },
    { ...issue, repo: "a/b/c" },
    { ...issue, number: 0 },
    { ...issue, number: 1.5 },
    { ...issue, number: "12" },
    { ...issue, url: "http://github.com/acme/notes/issues/12" },
    { ...issue, url: "https://evil.example/acme/notes/issues/12" },
    "acme/notes#12",
  ]) assert.ok(C.validateReport(good({ issue: bad })).some((e) => /issue/.test(e)), JSON.stringify(bad));
});

test("new ids match the shape and differ", () => {
  const id = C.newReportId(new Date("2026-10-12T17:45:00Z"), () => "abc123");
  assert.equal(id, "r-20261012174500-abc123");
  assert.match(C.newReportId(), /^r-\d{14}-[a-z0-9]{6}$/);
  assert.notEqual(C.newReportId(), C.newReportId());
});

test("isReportId accepts only the id shape, so an id is safe to use as a folder name", () => {
  assert.equal(C.isReportId("r-20261012174500-abc123"), true);
  for (const bad of ["../etc", "r-1-abc123", "", null, "r-20261012174500-ABC123"]) assert.equal(C.isReportId(bad), false);
});

test("a route never keeps a query string", () => {
  assert.equal(C.sanitizeRoute("/photos?token=secret&x=1"), "/photos");
  assert.equal(C.sanitizeRoute("/photos#frag"), "/photos");
  assert.equal(C.sanitizeRoute("/a/b?x#y"), "/a/b");
  assert.equal(C.sanitizeRoute("/plain"), "/plain");
  assert.deepEqual(C.validateReport(good({ where: { screen: "P", route: "/photos?t=1" } })).filter((e) => /route/.test(e)).length, 1);
});

test("a valid report has no problems", () => {
  assert.deepEqual(C.validateReport(good()), []);
  assert.deepEqual(C.validateReport(good({ kind: "broken", broken: { happened: "x" } })), []);
});

test("unknown kind, role, or id are refused", () => {
  assert.ok(C.validateReport(good({ kind: "rant" })).some((e) => /kind/.test(e)));
  assert.ok(C.validateReport(good({ who: { member: "g", role: "boss" } })).some((e) => /role/.test(e)));
  assert.ok(C.validateReport(good({ id: "nope" })).some((e) => /id/.test(e)));
});

test("a report with an email is refused, wherever it sits", () => {
  assert.ok(C.validateReport(good({ who: { member: "alex", role: "operator", email: "a@example.com" } })).some((e) => /email/.test(e)));
  assert.ok(C.validateReport(good({ email: "a@example.com" })).some((e) => /email/.test(e)));
  assert.ok(C.validateReport(good({ diagnostics: { appVersion: "1", email: "a@example.com" } })).some((e) => /email/.test(e)));
});

test("diagnostics outside the four names are refused", () => {
  const errs = C.validateReport(good({ diagnostics: { appVersion: "1", cookies: "yes" } }));
  assert.ok(errs.some((e) => /cookies/.test(e)));
  assert.deepEqual(C.validateReport(good({ diagnostics: {} })), []);
});

test("seven images are refused; an app may choose lower ceilings and never higher", () => {
  const img = (i) => ({ file: `${i}.png`, type: "image/png", bytes: 10, sha256: String(i).padStart(64, "0") });
  assert.ok(C.validateReport(good({ media: [1, 2, 3, 4, 5, 6, 7].map(img) })).some((e) => /image/.test(e)));
  assert.deepEqual(C.validateReport(good({ media: [1, 2, 3, 4, 5, 6].map(img) })), []);
  const three = good({ media: [1, 2, 3, 4].map(img) });
  assert.ok(C.validateReport(three, { ceilings: { ...C.CEILINGS, images: 3 } }).some((e) => /image/.test(e)));
  assert.ok(C.validateReport(good(), { ceilings: { ...C.CEILINGS, images: 12 } }).some((e) => /ceiling/.test(e)));
});

test("size and length ceilings are enforced", () => {
  assert.ok(C.validateReport(good({ media: [{ file: "a.png", type: "image/png", bytes: 11 * 2 ** 20, sha256: "a".repeat(64) }] })).some((e) => /image/.test(e)));
  const vid = (bytes) => ({ file: "v.mp4", type: "video/mp4", bytes, sha256: "b".repeat(64) });
  assert.ok(C.validateReport(good({ media: [vid(101 * 2 ** 20)] })).some((e) => /video/.test(e)));
  assert.ok(C.validateReport(good({ media: [vid(1), { ...vid(1), file: "w.mp4" }] })).some((e) => /video/.test(e)));
  assert.ok(C.validateReport(good({ voice: [{ file: "v.m4a", ms: 300_001 }] })).some((e) => /voice/.test(e)));
  assert.ok(C.validateReport(good({ voice: [1, 2, 3, 4].map((i) => ({ file: `${i}.m4a`, ms: 250_000 })) })).some((e) => /voice/.test(e)));
});
