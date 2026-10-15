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

test("the status list is the design's, in order", () => {
  assert.deepEqual(C.STATUSES, ["on-phone", "received", "with-freeda", "planned", "waiting-on-owner", "being-made", "live", "sent-to-template", "filed", "not-now"]);
  assert.deepEqual(C.END, ["live", "sent-to-template", "filed", "not-now"]);
  assert.deepEqual(C.KINDS, ["change", "broken", "feedback"]);
  assert.deepEqual(C.ROLES, ["operator", "member", "maintainer"]);
});

test("every status has an actor and at least one next step, except the four ends", () => {
  for (const s of C.STATUSES) {
    const f = C.FLOW[s];
    assert.ok(["person", "app", "mac", "freeda", "owner"].includes(f.actor), `${s} has no actor`);
    if (C.END.includes(s)) assert.deepEqual(f.next, [], `${s} is an end`);
    else assert.ok(f.next.length >= 1, `${s} goes nowhere`);
    for (const n of f.next) assert.ok(C.STATUSES.includes(n), `${s} -> ${n} is not a status`);
  }
});

test("each status names who performs that step, as the design's section 7 does", () => {
  const actors = Object.fromEntries(C.STATUSES.map((s) => [s, C.FLOW[s].actor]));
  assert.deepEqual(actors, { "on-phone": "person", "received": "app", "with-freeda": "mac", "planned": "freeda", "waiting-on-owner": "owner", "being-made": "freeda", "live": "freeda", "sent-to-template": "freeda", "filed": "freeda", "not-now": "owner" });
});

test("the owner may decline a report Pluma has not planned, or has planned and not yet asked about", () => {
  // Without these a report the reading worker cannot plan has no exit: it shows "With Pluma" for ever.
  assert.equal(C.mayMove("with-freeda", "not-now"), true);
  assert.equal(C.mayMove("planned", "not-now"), true);
  assert.equal(C.mayMove("with-freeda", "filed"), false); // declining is the owner's; filing still comes from the work
  assert.equal(C.mayMove("with-freeda", "live"), false);
  assert.deepEqual(C.FLOW["with-freeda"].next, ["planned", "not-now"]);
  assert.deepEqual(C.FLOW["planned"].next, ["waiting-on-owner", "being-made", "not-now"]);
});

test("a move the flow forbids is refused", () => {
  assert.equal(C.mayMove("with-freeda", "being-made"), false);
  assert.equal(C.mayMove("waiting-on-owner", "being-made"), true);
  assert.equal(C.mayMove("live", "received"), false);
  assert.equal(C.mayMove("nonsense", "live"), false);
});

test("wordsFor carries the design's table, with the owner's name", () => {
  const w = (s) => C.wordsFor(s, { owner: "Alex" });
  assert.equal(w("on-phone"), "On this phone");
  assert.equal(w("received"), "Received");
  assert.equal(w("with-freeda"), "With Pluma");
  assert.equal(w("waiting-on-owner"), "Waiting on Alex");
  assert.equal(C.wordsFor("waiting-on-owner", { owner: "Sam" }), "Waiting on Sam");
  assert.equal(w("being-made"), "Being made");
  assert.equal(w("live"), "Done");
  assert.equal(w("sent-to-template"), "Sent to the template");
  assert.equal(w("filed"), "Filed");
  assert.equal(w("not-now"), "Not now");
  assert.equal(w("planned"), "With Pluma");
  assert.equal(C.meaningFor("with-freeda", { owner: "Alex" }), "Alex's Mac has picked it up");
  assert.equal(C.meaningFor("waiting-on-owner", { owner: "Alex" }), "Pluma has a plan and is asking Alex");
  assert.throws(() => C.wordsFor("bogus", { owner: "Alex" }), /not a status/);
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
