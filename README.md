# @supersuit/suggest-a-change

The report format and flow behind a Suggest a change button: what a report is, who acts at each step, the screens, and the check every app runs. The contract (the package root) has zero dependencies.

## 30 seconds

```bash
npm install @supersuit/suggest-a-change
```

```js
import { KINDS, STATUSES, FLOW, CEILINGS } from "@supersuit/suggest-a-change";

console.log(KINDS);            // ["change", "broken", "feedback"]
console.log(FLOW["with-freeda"]); // { actor: "mac", next: ["planned", "not-now"] }
```

The package root is the report contract: the kinds, roles, ceilings, the status list and the flow map (who performs each step and which moves are allowed), plus the functions that validate a report against them. It has no imports, so it can also be copied whole into a place that has no install step. If you copy it, keep a hash of the copy and fail a test when the bytes change; fix the contract here and copy it again.

The client core is TypeScript, built to `dist/` with declarations. `"./client"` is one entry point that includes the screens, so it needs React 19 installed in the app (the contract at the package root and `"./check"` do not):

```ts
import { openStore, makeOutbox, makeReportSender, queueReport, draftKey, saveDraft, startTake, recoverTakes } from "@supersuit/suggest-a-change/client";
```

A draft is keyed `sac:<app>:<account>`, so switching people never shows another person's draft, and it carries the report id made when it started. A report goes into the outbox as one `report` write and one `reportPart` per attachment, and the draft is cleared only when the last of them has landed. `StoreAdapter` is the interface an app implements for the receiving side.

### The screens (React 19, optional peer)

`"./client"` also carries the screens: `SuggestEntry`, `SuggestSheet`, `Receipt`, `MySuggestions`, `SuggestionDetail`, `ReportProblem`, `DefaultField`, `Toasts`, and `receiptWords`. An app supplies `Adapters`:

```tsx
import { SuggestEntry, SuggestSheet, type Adapters } from "@supersuit/suggest-a-change/client";
import "@supersuit/suggest-a-change/styles.css"; // optional

const adapters: Adapters = {
  identity: async () => (user ? { account: user.memberKey, role: "member" } : null),
  store,                                  // a StoreAdapter: submit, uploadPart, mine, one, append (dedupe by id)
  words: { app: "notes", owner: "Alex" },    // the owner's name is passed in, never written in the module
  limits: { images: 3 },                  // may lower the ceilings, never raise them
  Field: GoldenVoiceField,                // optional: a host's own voice field; the module ships DefaultField
  snapshot: async () => screenshotBlob(), // optional: one tap to attach a picture of this screen
  about: { app: "notes", version: "1.2.3" }, // stamped into every report
  lands: "app",                           // "mac" on a Helm that posts straight to the owner's Mac
  hear: (key, blob, ms) => transcribe(blob), // optional: the words of one take, shown under it before Send
};
// On every screen below home:  <SuggestEntry adapters={adapters} onOpen={() => setOpen(true)} />
// then:                        {open && <SuggestSheet adapters={adapters} where={{ screen: "Photos", route: location.pathname }} onClose={() => setOpen(false)} />}
```

`SuggestEntry` also takes `className` and `role` (for example `role="menuitem"` when a host shows it as a menu row); no role is set by default. My suggestions and the detail view keep their last answer from the app on the phone (module-owned IndexedDB, keyed by app and account like a draft), draw it at once with a quiet "Updating" line, and replace it when the app answers; if the app cannot be reached they keep the saved rows and say so. An adapter tells a refusal from an unreachable app: `mine()` and `one()` throw an error with `refused: true` or a `status` of 401, 403 or 404 for a refusal (the saved copy is then deleted), and anything else thrown is unreachable. Saved reports the list no longer holds are pruned, and signing out clears them. A first open with nothing saved shows "Loading".

The entry also keeps the phone's outbox moving while it is mounted (a report sent with the Mac away goes when it is back, with the sheet closed); a host with no always-mounted entry renders `<KeepSending adapters={adapters} />` once, high in the app. The entry carries `data-suggest-entry` (the attribute the screen check looks for; see "The check" below). Signed out, it opens nothing and says why. The receipt says "Got it" only after the adapter has answered `done` for the report and every attachment; until then it says the report is on the phone. Every text field the module renders sits in a `[data-voice-field]` container with a `[data-voice-control]`; a host's `Field` slot must keep that shape (it receives `FieldProps`, which is the Helm's voice field props). A voice note alone is a whole report: the recording is kept and uploaded as a part, and the receiving Mac writes the transcript. A host with a transcriber of its own supplies `hear(key, blob, ms)`, which resolves the words of one take, or `null` when nothing could be heard, and may throw when it cannot be reached. The sheet calls it in the background once the note is kept and listed, and shows under the note "Hearing it…", then the words as plain text, or "The words get written out when it arrives." (`words.text.hearingIt` and `heardLater`). The words are kept with the draft on the phone, so a reopened sheet shows them again; they are a preview only and never go in the report. Without `hear` a note shows only its name.

Styling: structure only, class names prefixed `sac-`. `@supersuit/suggest-a-change/styles.css` is optional defaults (16px inputs so iOS does not zoom, 44px touch targets, safe-area padding on the sheet). Re-skin it with these custom properties:

| Property | Default | Used for |
| --- | --- | --- |
| `--sac-font` | `inherit` | all text |
| `--sac-fg` | `#1a1a1a` | text |
| `--sac-bg` | `#ffffff` | sheet and control backgrounds |
| `--sac-muted` | `#5f6368` | secondary text |
| `--sac-border` | `#cfd2d6` | outlines |
| `--sac-accent` | `#1a56db` | the primary button, the current step |
| `--sac-accent-fg` | `#ffffff` | text on the accent |
| `--sac-danger` | `#b3261e` | errors and the record dot |
| `--sac-radius` | `12px` | corners |
| `--sac-gap` | `12px` | spacing |
| `--sac-z` | `1000` | stacking of the sheet (toasts sit one above) |
| `--sac-backdrop` | `rgba(0, 0, 0, 0.45)` | the dim behind the sheet |
| `--sac-focus` | `#1a56db` | focus rings |

The four diagnostics are the app's version, the time, the screen size and the phone type. All four go with every report, with the screen's name and address, and the sheet says so in one small line above Send rather than a section of switches.

**Identity.** Every screen asks `adapters.identity()` when it mounts, whenever it is handed a different `adapters` object, and whenever the host calls `refreshIdentity()` (exported from `"./client"`; call it after a sign-in, sign-out or account switch). When the account differs, the old account's rows leave the screen and its waiting reports stay on the phone, to be sent only while that account is signed in; every send re-confirms the account first. Keep `adapters` stable where you can; a parent that rebuilds it every render is safe, only slower (one `identity()` call per render).

**Telling the person in the app, with no setup.** The entry asks `mine()` once when it mounts and compares each report's status with the one this account last opened (kept on the phone beside the cached views, per app and account, and cleared on sign-out). A report that has since been started or ended (`TOLD`) shows a dot on the entry, says New on its row in My suggestions, and the newest such move gets one toast per page load in the module's words (`words.text.movedToast`, given the status's own word and, on `not-now`, the reason: "Your suggestion: Done", "Your suggestion: Not now. too big for now"). Opening the report clears it. A report this phone sees for the first time is recorded silently, so an app taking this release does not announce every old report. The list's `not-now` rows carry their one-line `note` for this. Out of the app, the server's `tellSubmitter` does the telling (below).

**When the entry sits in a menu.** A host that shows the entry inside a menu that stays closed (a three-dot menu, often remounting its rows on every open) would never show the dot, and the toast would be drawn inside the closed menu. Mount `<SuggestNews>` once at the app's root, always mounted: it asks `mine()` when it mounts, shows the page load's one toast with no entry on screen, and keeps the outbox moving. Put the dot on the menu's own trigger with `useSuggestNews(adapters)`, which returns `{ moved }`, and `<SuggestDot>`, which draws the entry's dot (nothing when `moved` is 0). The trigger needs `position: relative`; the class `sac-dot-host` does it. The toast is once per page load and account however many times the entry mounts, whichever of these asks first. The entry in the menu keeps its own dot.

```tsx
import { SuggestDot, SuggestEntry, SuggestNews, useSuggestNews } from "@supersuit/suggest-a-change/client";

// once, at the root
<SuggestNews adapters={adapters} />

// the menu's trigger
function MoreButton({ onClick }: { onClick(): void }) {
  const { moved } = useSuggestNews(adapters);
  return (
    <button type="button" className="sac-dot-host" aria-label="More" onClick={onClick}>
      ...<SuggestDot adapters={adapters} moved={moved} />
    </button>
  );
}

// inside the menu, as before
<SuggestEntry adapters={adapters} role="menuitem" onOpen={() => setOpen(true)} />
```

`<SuggestNews>` also takes `children`, a function given `{ moved }`, for a root that draws the trigger itself. A host using only the hook renders `<Toasts />` somewhere always mounted so the toast has a place to show.

**Follow-ups.** Words and voice notes added to a report afterwards are queued in the outbox like the report (a `followUp` write, then one part per voice note), keep the app's refusal with a Try again, and delete their local copy only once they have landed. `StoreAdapter.append` must therefore dedupe by report id and `more.followId`.

## The check: every screen carries the button

`suggest-a-change-check` fails an app whose screens lack the Suggest a change entry, or whose adapters are not all supplied. Each app calls it from its own check script. Run it from the app's folder:

```bash
npx suggest-a-change-check
npx suggest-a-change-check --help
```

Exit 0 is clean, 1 is problems (each printed with the file and the fix), 2 is a usage error or nothing to check. `--json` prints `{ ok, problems, checked, exempted }`. The flags are `--repo`, `--config`, `--app-dir`, `--adapters` and `--strict`. An app directory with no pages is a usage error (exit 2: nothing was checked), as is an app directory outside the repo.

**Put `suggest-a-change-check --strict` in the app's check script** once the adapters are real. `init` writes stubs that sign nobody in and refuse every report, and marks the file with a `suggest-a-change: STUB` line. Without `--strict` that line is a `warning:` (also in the `--json` `warnings`) and the exit stays 0; with `--strict` it is a problem and the exit is 1. Delete the line when the four adapters are real. The stub also carries `tellSubmitter` for the server half, which `createReportHandlers` requires (see below), and `init` says so in its notes whenever the adapters file has none.

For a Next.js app (app router) it reads source, not a running app:

- It takes the same screen list the home-screen check takes (see "The screen list" below): every page under the app directory (`appDir` in `home-screen.json`, else `src/app`, else `app`), minus the routes listed under `home` (default `/`).
- A screen passes when its page, or any layout or template from the app directory down to the page's own folder (nested layouts and route groups included), renders `<SuggestEntry` or carries `data-suggest-entry` as a JSX element or attribute. The entry may come through a component the file imports, but only if the file actually uses that import: it appears as an element (`<Shell>`), is passed as a value inside JSX (`<Providers Layout={Shell}>`), or is assigned to a const that is rendered (`const W = Shell; <W />`). Importing it is not enough, and calling a function with it (`String(Shell)`) is not using it. The imported NAME is carried through barrel files: a barrel that re-exports both Shell and Button covers a layout that renders Shell, never one that renders only Button. `export { A as B } from`, `export { default as X } from`, `export * from`, `export * as ns from`, and `import { X } from ...; export { X }` / `export default X` all pass the name along. For a namespace import (`import * as ui`) only the members rendered count: `<ui.Button />` is covered only if Button's export reaches the entry, while `<ui.Shell />` is covered if Shell's does; a namespace handed on whole (`parts={ui}`) counts every member. Relative, `@/` and `~/` imports are followed three levels deep, each re-export hop counting as one. A match inside a string literal, a comment or a template string does not count; JSX text is text, so an apostrophe in it starts nothing.
- A screen that should not have the button is listed in the same config file, with a reason:

  ```json
  { "home": ["/"], "suggest-a-change": { "exempt": { "/share/[token]": "opened by someone who is not a member" } } }
  ```

  An exemption with an empty reason, or for a route that no longer exists, is a problem.
- The adapters file (`tailor/suggest-a-change.ts`, or the path under `"suggest-a-change": { "adapters": "..." }`) must export all four of `identity`, `store`, `words` and `limits`, directly or through `export *` and `export { x as y }` from a local file.

What it cannot see: an entry rendered only under a condition, which component inside an imported file renders the entry (it checks the file: when one file defines both the entry-bearing component and other components, rendering any of that file's exports counts as covered), a component reached through more than three levels of imports, an import through a path alias other than `@/` and `~/`, an entry that code builds from a string, and a regular expression literal containing a quote, which can confuse its reading of the rest of that file. It reads text, so it will say a screen is covered when the entry exists in the source and never shows at runtime. Keep the entry unconditional (a signed-out visitor is told why by the entry itself).

### The screen list

The check copies the route rules of a template's `living/home-screen-contract.mjs`, so both sides name the same screens. These are the rules, pinned by the `routes` fixture in `test/fixtures/` and the test `the screen list follows the rules the home-screen check follows`; change one side and the other must change with it:

- A screen is a file named `page.tsx`, `page.ts`, `page.jsx`, `page.js` or `page.mdx`. `page.test.tsx`, `page.dev.tsx` and `route.ts` are not screens.
- Any file under a folder whose name starts with `_` is skipped.
- Route groups, folders named `(name)`, are dropped from the route: `(marketing)/about/page.tsx` is `/about`.
- Parallel-route slots, folders named `@name`, are dropped: `@sidebar/stats/page.tsx` is `/stats`.
- Dynamic segments stay as written: `[id]`, `[...slug]`, `[[...path]]`.
- Intercepting folders `(.)x`, `(..)x` and `(...)x` are NOT dropped (only a folder name that both starts with `(` and ends with `)` is a group), so `photos/(.)view/[id]/page.tsx` is `/photos/(.)view/[id]`.
- A route is exempt from the check if it is a `home` route, or listed under `suggest-a-change.exempt` with a reason.

An app with one shell and no per-screen pages (a single-page app) checks its route list instead:

```js
import { checkEntryOnRoutes } from "@supersuit/suggest-a-change/check";

const problems = checkEntryOnRoutes({
  routes: ["/", "/inbox", { route: "/print", exempt: "a printed page" }],
  render: (route) => renderToString(<App route={route} />), // returns the route's HTML
});
// [] when every route's HTML has an element carrying data-suggest-entry. checkEntryOnRoutesAsync takes an async render.
```

`checkSuggestEverywhere({ repo, appDir, config, adaptersFile })` is the same check as the command, as a function that returns the problems (it throws `UsageError` when there is no app directory to check).

### Wiring a new app

```bash
npx suggest-a-change init
```

Run it in the app's folder. It adds the dependency to `package.json`, writes `tailor/suggest-a-change.ts` with the four adapters stubbed (kept as it is if it exists), adds `suggest-a-change-check` to the app's check script (`living:check` if the app has one, else `check`), writes `src/components/suggest-a-change.tsx`, and renders it in the root layout (before the last JSX `{children}`, never a destructured parameter). It keeps `package.json`'s indent and the order of the other dependencies, and refuses an app directory outside the repo. The adapters it writes are stubs and `init` says so. Running it again changes nothing. Then install your dependencies and fill in the four adapters. `--repo`, `--app` (the id in `words.app`) and `--owner` (the first name the receipt says) are optional; `suggest-a-change check` is the same command as `suggest-a-change-check`.

Check this package (typecheck, client tests, build, node tests, the commands):

```bash
npm ci
npm run check
```

Development needs Node 22 or newer (vitest and jsdom); the built package runs on Node 20 and up.

## The server half (`./server`)

Web-standard only (`Request`, `Response`, `crypto.subtle`), no runtime dependency, nothing from react or the client. A hosted app mounts the handlers and supplies a storage adapter.

```ts
import { createReportHandlers } from "@supersuit/suggest-a-change/server";

const h = createReportHandlers({
  store,                                  // your HostedStore (see runStoreConformance)
  identity: async (req) => member,        // { account } or null
  maintainers: ["mo"],                    // member keys with maintainer permission; ordinary membership never is
  agent: async (req) => maintainerKey,    // which maintainer's Mac is calling, or null
  limits: { perPersonPerDay: 10 },        // may lower a limit, never raise it (also voiceNotes, followUpVoiceNotes, followUps, agentPage)
  app: { name: "Notes" },                 // stamped into every report from here; an app in the body is ignored
  maintainersSince: { mo: "2026-10-01" }, // optional: reports from before this are not offered to that maintainer's Mac
  tell: (e) => notify(e),                 // ids only, never words; a failure never fails the request
  tellSubmitter: (e) => push(e.member, e.words, e.note), // REQUIRED: tell the person who suggested it (or { none: "<reason>" })
});
```

**Telling the person who suggested it is required.** `tellSubmitter` is called once when a report moves to `being-made` and once when it ends (`live`, `sent-to-template`, `filed`, `not-now`; the list is exported as `TOLD`), with `{ member, reportId, status, words, meaning, ended, note? }`. `words` and `meaning` are the module's own words for the status (`wordsFor`/`meaningFor`, with `app.owner` as the owner's name when given), never the report's text, so a lock screen never shows what someone wrote; `note` is the one-line reason and comes with `not-now` only. The planning steps (`with-freeda`, `planned`, `waiting-on-owner`) tell nobody, a repeat of a status tells nobody, a move the store refused tells nobody, and a maintainer is not told that the work they just started on their own report has started (its end is still told). Send it on the app's own channel (push, email, an activity row) to that member only. A failure never fails the move. `createReportHandlers` throws at startup when `tellSubmitter` is missing; an app that genuinely has nobody to tell passes `tellSubmitter: { none: "only the maintainer uses this app" }`, and an empty reason throws too. The `tell` event for a status move now also carries `member` and `status`.

| Route | Handler | Answers |
| --- | --- | --- |
| `POST /api/reports` | `submit` | 200 (a repeat of the same id is 200 too), 400, 401, 413, 422, 429 |
| `POST /api/reports/upload-url` | `uploadUrl` | 200 `{ url, headers }` (or `{ done }`), 400, 401, 404, 413 |
| `POST /api/reports/:id/finalize` | `finalize` | 200, 401, 404, 409 (not arrived yet), 422 (contents are not the declared type) |
| `GET /api/reports/mine` | `mine` | 200, 401 |
| `GET /api/reports/:id` | `one(req, id)` | 200, 401, 404 (missing and not yours look the same) |
| `POST /api/reports/:id/append` | `append(req, id)` | 200, 400, 401, 404 (not the owner's: same as missing), 409 (the suggestion has ended) |
| `GET /api/agent/reports` | `agentList` | 200 `{ reports }`: one page (20, oldest first) of what is open for this Mac, each claimed for ten minutes; a report whose files are still arriving waits up to an hour; a report another maintainer closed is never offered (it is settled for this Mac unseen); `heldBy` names the maintainer whose Mac is making a report |
| `GET /api/agent/reports/:id/files/:file` | `agentFile(req, id, file)` | 200 `{ url, expiresAt, type, bytes, sha256 }` (the link lives five minutes), 404 |
| `POST /api/agent/reports/:id/settle` | `agentSettle` | body `{ revision }` (the one the list gave this report): 200, 400 (no revision), 409 (not claimed, or `stale`: something was added since the list, so the report is offered again) |
| `POST /api/agent/reports/:id/claim-approval` | `agentClaimApproval` | 200, or 409 `{ claimedBy }`, or on a closed report 409 `{ closed: true, status, claimedBy? }` |
| `POST /api/agent/reports/:id/status` | `agentStatus` | 200, 400, 409 |

A client adapter's `uploadPart` asks `upload-url`, PUTs the bytes straight to storage, then calls `finalize`. Nothing is uploaded through the app's server and no handler reads a body over about 400 KB (sized from the field limits at four bytes a character; far under 4 MB).

The role stored on a report comes from the signed-in member and the `maintainers` list. A `who` sent by the phone is ignored; a report carrying `timeline`, `status`, `plan` or `decision` is refused. `sniffType(firstBytes)` names a file by its bytes (jpeg, png, webp, heic/heif, gif, mp4/mov, webm, m4a/aac, mp3, wav, ogg/opus; anything else is `null`) and `finalize` refuses a file whose bytes are not the type it was declared as.

**A wrapper of your own answers in the module's words.** When an app's route has to check a caller or read one field before the handler runs, it uses the same door the handlers use: `json(status, body)` (JSON, never cached), `signIn()` (401) and `notFound()` (404), `cappedText(req, cap)` (the body as text, or a 413 `Response` past `cap` bytes, by the declared length and again by counting what arrives; no body reads as `""`), and `peek(text)` (a JSON object, or `{}` for anything else, for reading one field while the module judges the body). Copying these into an app made a second door that could drift from the first.

**Settle carries a revision.** `agentList` gives each report a `revision`; the Mac sends it back with `settle`, and the store settles only if the report still has exactly that content. A follow-up or file that arrived in between answers 409 `stale`, drops the claim, and the next list offers the report with the addition. Adapters compute the same value with `reportRevision`.

**The collector MUST verify.** `agentFile` answers the verified `bytes` and `sha256`; a Mac that downloads the link must check both before it trusts the file.

**The approval.** Moves before the owner is asked (`with-freeda`, `planned`, `waiting-on-owner`) need no claim. Leaving `waiting-on-owner`, starting `being-made` and any end status need the Mac that holds the approval (taken atomically if nobody holds it, otherwise 409 with who does). Before the work starts the holder can release it, and an unrenewed approval lapses after seven days. Once the work starts or ends it does not lapse: the move to `being-made` or to an end names the maintainer on its timeline entry (`holder`, never shown to the member), the approval is taken for `HELD_MS`, and another Mac asking is answered 409 with that holder. A claim on a closed report is 409 `{ closed: true, status, claimedBy }` for everyone, the holder included, and writes nothing. The owner may decline (`not-now`) from `with-freeda` and `planned` as well as from `waiting-on-owner`.

**What a storage adapter implements** (`HostedStore`). Every method that changes a report is narrow and atomic: `put` is create-only (`created`, `exists`, or `limit` when the member's day is full, counted in the same transaction), and `setFile` (never replaces a verified entry; an older pending never replaces a newer one), `addFollowUp` (the caps, a reused file name and an ended report are checked inside the write), `setStatus(expectFrom)`, `claimApproval`, `claim`, `settle` and `reopen` each change one thing. A real adapter implements these with a transaction or a precondition, never "read the report, change a copy, write it back": that rolls back a status or a claim written in between. Upload links must be create-only and one-time with the size and type fixed in their conditions (a Firebase or S3 signed PUT with `if-generation-match: 0` or `If-None-Match: *`), `discard` must delete a refused object, and `readUrl` links must expire after `ttlMs`.

**Every adapter must pass the conformance suite**, against the adapter and its real storage:

```ts
import { runStoreConformance } from "@supersuit/suggest-a-change/server";
await runStoreConformance(() => ({ store, now, advance, putViaLink, getViaLink, objectKeys }), { test }); // the runner's own `test`
// putViaLink / getViaLink do what your storage service does with a PUT on an upload link and a GET on a read link.
```

## What is here, and what is coming

| Export | State |
| --- | --- |
| `"."` the report contract | here |
| `"./client"` ids, drafts, the report outbox and the recorder | here |
| `"./client"` the toast, entry, sheet, receipt, My suggestions and detail (React 19, optional peer) | here |
| `"./styles.css"` optional defaults | here |
| `"./check"` and the `suggest-a-change-check` and `suggest-a-change init` commands | here |
| `"./server"` the receiving side: handlers, store conformance suite, byte sniffing | here |

Each export is added to `package.json` in the same change as its code, so nothing here points at a file that does not exist.

## Status

Version 0.1.0 is the first release and is published once by its owner (the first publish of a new package name cannot be a tag push). Every release after that is a pushed `v<version>` tag (GitHub Actions, npm trusted publishing). Below 1.0, additions are patch versions, so apps on `^0.1.0` take them without a change.

## License

MIT
