// src/contract.mjs (@supersuit/suggest-a-change)
// THE REPORT CONTRACT AND THE FLOW MAP for Suggest a change (design sections 4, 5 and 7). ZERO
// imports on purpose, so it can be vendored whole where an install step does not exist: the phone, the
// hosted apps and Freeda's inbox all validate against this one copy. The flow lives here, with who acts
// at each step, so what a person sees cannot drift from what happened.

export const KINDS = ["change", "broken", "feedback"];
export const ROLES = ["operator", "member", "maintainer"];

export const CEILINGS = {
  images: 6, imageBytes: 10 * 2 ** 20,
  videos: 1, videoBytes: 100 * 2 ** 20, videoMs: 60_000,
  voiceMs: 300_000, voiceTotalMs: 900_000,
  perPersonPerDay: 20,
};

export const STATUSES = ["on-phone", "received", "with-freeda", "planned", "waiting-on-owner", "being-made", "live", "sent-to-template", "filed", "not-now"];
export const END = ["live", "sent-to-template", "filed", "not-now"];

// actor: who PERFORMS this step (design section 7): sent by the person, received by the app, with Freeda by the Mac. A Helm on the owner's Mac posts straight into
// the inbox, so a report may go from the phone to Freeda without the hosted app's "received".
export const FLOW = {
  "on-phone": { actor: "person", next: ["received", "with-freeda"] },
  "received": { actor: "app", next: ["with-freeda"] },
  "with-freeda": { actor: "mac", next: ["planned"] },
  "planned": { actor: "freeda", next: ["waiting-on-owner", "being-made"] },
  "waiting-on-owner": { actor: "owner", next: ["being-made", "filed", "not-now"] },
  "being-made": { actor: "freeda", next: ["live", "sent-to-template", "filed", "not-now"] },
  "live": { actor: "freeda", next: [] },
  "sent-to-template": { actor: "freeda", next: [] },
  "filed": { actor: "freeda", next: [] },
  "not-now": { actor: "owner", next: [] },
};

export const mayMove = (from, to) => Boolean(FLOW[from]?.next.includes(to));

// The design's status table (section 2), word for word. "planned" is a step inside Freeda's work
// that the table does not name for a person, so it reads as "With Freeda".
const TABLE = {
  "on-phone": ["On this phone", () => "Not sent yet; it will send when there is a connection"],
  "received": ["Received", () => "The app has it, safely stored"],
  "with-freeda": ["With Freeda", (o) => `${o}'s Mac has picked it up`],
  "planned": ["With Freeda", (o) => `${o}'s Mac has picked it up`],
  "waiting-on-owner": [null, (o) => `Freeda has a plan and is asking ${o}`],
  "being-made": ["Being made", () => "A session is working on it; the current step shows underneath"],
  "live": ["Done", () => "Shipped in the app, with the date it went live"],
  "sent-to-template": ["Sent to the template", () => "It became a change to the template every copy of this app uses; it reaches this app once merged"],
  "filed": ["Filed", () => "It was passed to whoever owns the problem"],
  "not-now": ["Not now", (o) => `${o} decided against it, with the one-line reason if given`],
};
const row = (status) => {
  if (!TABLE[status]) throw new Error(`${status} is not a status`);
  return TABLE[status];
};
export const wordsFor = (status, { owner } = {}) => row(status)[0] ?? `Waiting on ${owner}`;
export const meaningFor = (status, { owner } = {}) => row(status)[1](owner);

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
  for (const p of findKey(raw, "email")) errs.push(`${p}: a report never carries an email`);
  if (String(raw.where?.route ?? "").includes("?")) errs.push("where.route keeps a query string");
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
