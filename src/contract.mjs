// src/contract.mjs (@supersuit/suggest-a-change)
// THE REPORT CONTRACT AND THE FLOW MAP for Suggest a change (design sections 4, 5 and 7). ZERO
// imports on purpose, so it can be vendored whole where an install step does not exist: the phone, the
// hosted apps and Pluma's inbox all validate against this one copy. The flow lives here, with who acts
// at each step, so what a person sees cannot drift from what happened.

export const KINDS = ["change", "broken", "feedback"];
export const ROLES = ["operator", "member", "maintainer"];

export const CEILINGS = {
  images: 6, imageBytes: 10 * 2 ** 20,
  videos: 1, videoBytes: 100 * 2 ** 20, videoMs: 60_000,
  voiceMs: 300_000, voiceTotalMs: 900_000,
  perPersonPerDay: 20,
};

// A suggestion becomes one ordinary GitHub issue (suggestions-as-github-issues design, section 3), so the statuses a
// person sees are GitHub's: not sent, received, held before filing, then the issue's own open and closed states.
export const STATUSES = ["on-phone", "received", "held", "open", "done", "not-planned"];
// Closed on GitHub. A closed issue can be reopened, so an end is not final: it can go back to "open".
export const END = ["done", "not-planned"];
// The moves the person who suggested a change hears about: the issue existing, and every close.
export const TOLD = ["open", ...END];

// actor: who PERFORMS this step. Sent by the person, received by the app, held for the owner (the privacy catch stopped
// it, or the account cannot file yet), filed by the Mac (or an app's own server), closed or reopened on GitHub. A Helm on
// the owner's Mac posts straight there, so a report may go from the phone to held or open without the app's "received".
export const FLOW = {
  "on-phone": { actor: "person", next: ["received", "held", "open"] },
  "received": { actor: "app", next: ["held", "open", "not-planned"] },
  "held": { actor: "owner", next: ["open", "not-planned"] },
  "open": { actor: "mac", next: ["done", "not-planned"] },
  "done": { actor: "github", next: ["open"] },
  "not-planned": { actor: "github", next: ["open"] },
};

// THE OLD STATUSES (0.1.x) STAY READABLE. Each folds into what it now means: a report the old pipeline was still
// working on has not been filed yet (the Mac files it), one it shipped or passed on is done, one declined is not planned.
export const LEGACY = {
  "with-freeda": "received",
  "planned": "received",
  "waiting-on-owner": "received",
  "being-made": "received",
  "live": "done",
  "sent-to-template": "done",
  "filed": "done",
  "not-now": "not-planned",
};
/** The status this one means now: a legacy status folded, anything else as it is. */
export const currentStatus = (s) => LEGACY[s] ?? s;

export const mayMove = (from, to) => Boolean(FLOW[currentStatus(from)]?.next.includes(to));

// The design's status table (section 3), word for word.
const issueWords = (issue) => (Number.isInteger(issue?.number) ? `Filed as issue #${issue.number}` : "Filed as an issue");
const TABLE = {
  "on-phone": [() => "On this phone", () => "Not sent yet; it will send when there is a connection"],
  "received": [() => "Received", () => "The app has it, safely stored"],
  "held": [(o) => `Waiting on ${o}`, (o) => `${o} looks at it before it is filed`],
  "open": [() => "Open", (o, issue) => issueWords(issue)],
  "done": [() => "Done", () => "Closed as completed"],
  "not-planned": [() => "Not planned", () => "Closed as not planned, with the reason if one was given"],
};
const row = (status) => {
  const s = currentStatus(status);
  if (!TABLE[s]) throw new Error(`${status} is not a status`);
  return TABLE[s];
};
export const wordsFor = (status, { owner } = {}) => row(status)[0](owner);
export const meaningFor = (status, { owner, issue } = {}) => row(status)[1](owner, issue);

// HOW TO REACH THE SENDER: what the app already knows of them, so whoever fixes it can say thanks or ask a question.
const CONTACT_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CONTACT_PHONE = /^\+?[0-9][0-9 ().-]{5,24}$/;
export function validContact(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return ["who.contact is not an object"];
  const errs = [];
  for (const k of Object.keys(c)) if (!["email", "phone", "handle"].includes(k)) errs.push(`who.contact.${k} is not one of email, phone, handle`);
  if (c.email !== undefined && (typeof c.email !== "string" || c.email.length > 254 || !CONTACT_EMAIL.test(c.email))) errs.push("who.contact.email is not an email address");
  if (c.phone !== undefined && (typeof c.phone !== "string" || !CONTACT_PHONE.test(c.phone))) errs.push("who.contact.phone is not a phone number");
  if (c.handle !== undefined && (typeof c.handle !== "string" || !c.handle.trim() || c.handle.length > 100 || /[\r\n]/.test(c.handle))) errs.push("who.contact.handle is not a short one-line handle");
  return errs;
}

// THE CONTEXT a report carries so it can be fixed: labelled items, each with why it is shared, and the trail that led here.
export const CONTEXT_CEILINGS = { items: 40, routes: 10, taps: 20, errors: 10 };
const shortText = (v, max) => typeof v === "string" && v.length <= max;
export function validContext(ctx) {
  if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) return ["context is not an object"];
  const errs = [];
  const list = (name, max, check) => {
    const v = ctx[name];
    if (v === undefined) return;
    if (!Array.isArray(v)) { errs.push(`context.${name} is not a list`); return; }
    if (v.length > max) errs.push(`context.${name} has ${v.length} entries; the ceiling is ${max}`);
    v.forEach((x, i) => { const e = x && typeof x === "object" ? check(x) : "is not an object"; if (e) errs.push(`context.${name}.${i} ${e}`); });
  };
  list("items", CONTEXT_CEILINGS.items, (x) =>
    !shortText(x.key, 40) || !/^[A-Za-z0-9:_-]+$/.test(x.key) ? "has no plain key"
      : !shortText(x.label, 80) || !x.label ? "has no short label"
      : !shortText(x.value, 500) ? "has no value of at most 500 characters"
      : !shortText(x.why, 200) || !x.why.trim() ? "does not say why it is shared" : null);
  list("routes", CONTEXT_CEILINGS.routes, (x) => (!shortText(x.route, 300) || /[?#]/.test(x.route) ? "is not a route without its query" : !shortText(x.at, 40) ? "has no time" : null));
  list("taps", CONTEXT_CEILINGS.taps, (x) => (!shortText(x.label, 80) ? "has no label of at most 80 characters" : !shortText(x.at, 40) ? "has no time" : null));
  list("errors", CONTEXT_CEILINGS.errors, (x) => (!shortText(x.message, 300) ? "has no message of at most 300 characters" : x.frame !== undefined && !shortText(x.frame, 200) ? "has a frame over 200 characters" : !shortText(x.at, 40) ? "has no time" : null));
  return errs;
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** The issue a report became: `{ repo: "owner/name", number, url }`, the url on github.com. Problems as a list. */
export function validIssue(issue) {
  if (!issue || typeof issue !== "object" || Array.isArray(issue)) return ["issue is not an object"];
  const errs = [];
  if (typeof issue.repo !== "string" || !REPO.test(issue.repo)) errs.push("issue.repo is not owner/name");
  if (!Number.isInteger(issue.number) || issue.number < 1) errs.push("issue.number is not a positive whole number");
  if (typeof issue.url !== "string" || !issue.url.startsWith("https://github.com/")) errs.push("issue.url is not a https://github.com/ link");
  return errs;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const randomSix = () => {
  let s = "";
  for (let i = 0; i < 6; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
};
export function newReportId(now = new Date(), rand = randomSix) {
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `r-${stamp}-${rand()}`;
}

export const sanitizeRoute = (url) => String(url ?? "").split(/[?#]/)[0];

const DIAGNOSTIC_KEYS = ["appVersion", "at", "device", "screen"];
const ID = /^r-\d{14}-[a-z0-9]{6}$/;
export const isReportId = (id) => ID.test(String(id ?? ""));

function findKey(value, key, path = "report", out = []) {
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k.toLowerCase() === key) out.push(`${path}.${k}`);
      findKey(v, key, `${path}.${k}`, out);
    }
  }
  return out;
}

export function validateReport(raw, { ceilings = CEILINGS } = {}) {
  const errs = [];
  if (!raw || typeof raw !== "object") return ["the report is not an object"];
  for (const k of Object.keys(CEILINGS)) {
    if (ceilings[k] > CEILINGS[k]) errs.push(`the ${k} ceiling ${ceilings[k]} is above the module's ${CEILINGS[k]}`);
  }
  const c = { ...CEILINGS, ...ceilings };
  if (!ID.test(String(raw.id ?? ""))) errs.push("the id is not a report id");
  if (!KINDS.includes(raw.kind)) errs.push(`kind ${JSON.stringify(raw.kind)} is not one of ${KINDS.join(", ")}`);
  if (!ROLES.includes(raw.who?.role)) errs.push(`role ${JSON.stringify(raw.who?.role)} is not one of ${ROLES.join(", ")}`);
  // The one place an email may sit is the sender's own way to be reached, who.contact.email, and only there.
  for (const p of findKey(raw, "email")) if (p !== "report.who.contact.email") errs.push(`${p}: a report never carries an email`);
  if (raw.who?.contact !== undefined) errs.push(...validContact(raw.who.contact));
  if (raw.context !== undefined) errs.push(...validContext(raw.context));
  if (String(raw.where?.route ?? "").includes("?")) errs.push("where.route keeps a query string");
  if (raw.issue !== undefined) errs.push(...validIssue(raw.issue));
  for (const k of Object.keys(raw.diagnostics ?? {})) {
    if (!DIAGNOSTIC_KEYS.includes(k)) errs.push(`diagnostics.${k} is not one of ${DIAGNOSTIC_KEYS.join(", ")}`);
  }
  const media = Array.isArray(raw.media) ? raw.media : [];
  const images = media.filter((m) => String(m.type).startsWith("image/"));
  const videos = media.filter((m) => String(m.type).startsWith("video/"));
  if (images.length > c.images) errs.push(`${images.length} images; the ceiling is ${c.images}`);
  for (const m of images) if (m.bytes > c.imageBytes) errs.push(`image ${m.file} is over ${c.imageBytes} bytes`);
  if (videos.length > c.videos) errs.push(`${videos.length} videos; the ceiling is ${c.videos}`);
  for (const m of videos) {
    if (m.bytes > c.videoBytes) errs.push(`video ${m.file} is over ${c.videoBytes} bytes`);
    if (m.ms != null && m.ms > c.videoMs) errs.push(`video ${m.file} is longer than ${c.videoMs} ms`);
  }
  const voice = Array.isArray(raw.voice) ? raw.voice : [];
  for (const v of voice) if (v.ms > c.voiceMs) errs.push(`voice note ${v.file} is longer than ${c.voiceMs} ms`);
  const total = voice.reduce((n, v) => n + (v.ms || 0), 0);
  if (total > c.voiceTotalMs) errs.push(`voice notes total ${total} ms; the ceiling is ${c.voiceTotalMs}`);
  return errs;
}

// WHAT AN ATTACHMENT MAY BE: one list, here, for the phone (which refuses the rest in words before anything
// is queued) and the hosted side (which refuses the rest again). Images and videos are `media`; audio is
// only ever a `voice` note.
export const ACCEPTED_TYPES = [
  "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/gif",
  "video/mp4", "video/quicktime", "video/webm",
  "audio/mp4", "audio/aac", "audio/mpeg", "audio/wav", "audio/ogg", "audio/webm",
];
const ALIASES = {
  "image/jpg": "image/jpeg", "audio/x-m4a": "audio/mp4", "audio/m4a": "audio/mp4", "audio/mp3": "audio/mpeg",
  "audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "audio/opus": "audio/ogg", "audio/x-aac": "audio/aac",
};
/** A declared type without its parameters (`audio/webm;codecs=opus`), lowercased, with common aliases folded. */
export const canonicalType = (t) => {
  const base = String(t ?? "").split(";")[0].trim().toLowerCase();
  return ALIASES[base] ?? base;
};
const BY_EXTENSION = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif", gif: "image/gif",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm",
};
/** The type to declare for a picked file: the browser's own when it gave one, else (iOS sometimes gives an empty
 *  type for a HEIC) the one its extension names. The result may still be outside ACCEPTED_TYPES: the caller refuses it. */
export const typeForFile = (type, name) => {
  const t = canonicalType(type);
  if (t) return t;
  const ext = String(name ?? "").split(".").pop().toLowerCase();
  return BY_EXTENSION[ext] ?? "";
};
export const isAcceptedMedia = (t) => ACCEPTED_TYPES.includes(canonicalType(t)) && /^(image|video)\//.test(canonicalType(t));
