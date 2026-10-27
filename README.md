# @supersuit/suggest-a-change

The report format and flow behind a Suggest a change button: what a report is, who acts at each step, the screens, and the check every app runs. The contract (the package root) has zero dependencies.

## 30 seconds

```bash
npm install @supersuit/suggest-a-change
```

```js
import { KINDS, STATUSES, FLOW, CEILINGS } from "@supersuit/suggest-a-change";

console.log(KINDS);            // ["change", "broken", "feedback"]
console.log(FLOW["received"]); // { actor: "app", next: ["held", "open", "not-planned"] }
```

A suggestion becomes one ordinary GitHub issue. The statuses a person sees are GitHub's: `on-phone` (not sent yet), `received` (the app has it), `held` (waiting on the owner: the privacy catch stopped it, or the account cannot file yet), `open` (the issue exists), `done` and `not-planned` (closed; a reopened issue goes back to `open`). The 0.1 statuses stay readable: `LEGACY` maps each to the one it now means and `currentStatus(s)` folds it, and every function and screen here reads through it.

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
  destination: async () => ({ repo: "acme/notes", public: false, account: "alex-gh", attaches: true, name: "Alex Kim" }), // optional
};
// On every screen below home:  <SuggestEntry adapters={adapters} onOpen={() => setOpen(true)} />
// then:                        {open && <SuggestSheet adapters={adapters} where={{ screen: "Photos", route: location.pathname }} onClose={() => setOpen(false)} />}
```

`SuggestEntry` also takes `className` and `role` (for example `role="menuitem"` when a host shows it as a menu row); no role is set by default. My suggestions and the detail view keep their last answer from the app on the phone (module-owned IndexedDB, keyed by app and account like a draft), draw it at once with a quiet "Updating" line, and replace it when the app answers; if the app cannot be reached they keep the saved rows and say so. An adapter tells a refusal from an unreachable app: `mine()` and `one()` throw an error with `refused: true` or a `status` of 401, 403 or 404 for a refusal (the saved copy is then deleted), and anything else thrown is unreachable. Saved reports the list no longer holds are pruned, and signing out clears them. A first open with nothing saved shows "Loading".

The entry also keeps the phone's outbox moving while it is mounted (a report sent with the Mac away goes when it is back, with the sheet closed); a host with no always-mounted entry renders `<KeepSending adapters={adapters} />` once, high in the app. The entry carries `data-suggest-entry` (the attribute the screen check looks for; see "The check" below). Signed out, it opens nothing and says why. The receipt says "Got it" only after the adapter has answered `done` for the report and every attachment; until then it says the report is on the phone. Every text field the module renders sits in a `[data-voice-field]` container with a `[data-voice-control]`; a host's `Field` slot must keep that shape (it receives `FieldProps`, which is the Helm's voice field props). A voice note alone is a whole report: the recording is kept and uploaded as a part, and the receiving Mac writes the transcript.

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

**Every piece of context that helps fix it, shared by default, each saying why.** With no app code, the module collects at send time, and the sheet lists every item with its value and a one-line why, each with a tick box so the person can leave it out (what they added themselves, the app's version and their name always go). Anything unticked is dropped before the report leaves the phone, diagnostics included.

| Item | Value, for example | Why it is shared (the sheet's words) |
| --- | --- | --- |
| Your name in the app | `identity().name` or `.username`; never the account id | so whoever fixes it knows who to thank, and can look at your account if the problem is in it |
| Your local time | `2026-10-26 12:04 (America/Chicago, UTC-05:00)` | so the fixer can line it up with what the app logged at that moment |
| Your languages | `en-US, es` | some problems only happen in one language or date format |
| Your device | `iPhone, iOS 18.1, Safari 18.1` (User-Agent Client Hints when the browser has them, else the user agent, in plain words) | so the fixer can try it on the same kind of device and browser |
| Screen and window | `390x844 screen, 390x664 window, 3x pixels` | how things are laid out depends on the size of the screen and window |
| Appearance | `dark mode, reduced motion` | some problems only show in dark mode or with animations turned down |
| Connection | `online, wifi, 4g speed` | a slow or dropped connection explains many problems |
| How long the page was open | `12 minutes` | some problems only start after a page has been open a while |
| Pages you visited before this | the last 10, with times, never a query string, and a segment that looks like an id, token or address (a uuid, a long number, long hex or base64, over 24 characters, anything with an @) becomes `:id` | so the fixer can retrace how you got here |
| Your last taps | the last 20, by what the button or link is called; never what was typed | so the fixer can repeat what you did |
| Errors the page hit | the last 10 errors and unhandled rejections, message and first stack frame, no query strings | the error the app hit is often the fastest way to the cause |

The trail (pages, taps, errors) is kept from the moment any of the module's screens first mounts (the entry, `<KeepSending>`, `<SuggestNews>`), in memory only, in small ring buffers. Never captured: an input's value, the text of anything someone types into (an editable region, a text, search or combo box; it is "a text field"), the text of anything marked `data-private` or inside one (below), cookies, storage, query strings. A host that bundles two copies of the module still gets one trail and one set of listeners (the state sits on the global object under a registered symbol), and a reset never undoes a wrapper the host put on `history` after ours. `collectContext()` and `installContextListeners()` are exported from `"./client"` for a host that wants them elsewhere.

- **The app's own context.** `context: async () => [{ label: "Plan", value: "Pro, yearly", why: "some features only exist on Pro" }]` adds anything app-specific; an item without a `why` is dropped. Or `context: { items, precise: true }` to also ask the browser for a precise location (its permission prompt); without that, location is only the time zone, plus roughly where from the receiver (below).
- **Turning items off.** `context: { items?, precise?, off: ["taps", "pages"] }` turns any built-in item off, for an app whose screens would carry what it must not share (a family app whose buttons are a child's name, a visit or a medicine). The keys are `taps`, `pages`, `errors`, `time`, `language`, `device`, `screen`, `appearance`, `connection`, `age` and `account` (`ContextKey`, all of them in `CONTEXT_KEYS`). An item off is never collected (from the first mount, the trail keeps nothing of it and forgets what it had), never listed on the sheet, and never in the report or the issue; `device`, `screen` and `time` off also drop the matching diagnostic, so the one line does not promise it either. It lives on the `context` adapter, beside `precise`, because it answers the same question (what context goes) and needs no new adapter. The parity test holds the sheet's list and the composed issue to each other with items off.
- **`data-private`, per element.** A tap on an element marked `data-private`, or anything inside one, is kept only as "something private"; a button with a `data-private` part (`Visit for <span data-private>Mia</span>`) is kept by its other text ("Visit for"). Mark wherever a person's details render as tappable text, when the rest of the trail is still worth keeping. `data-private="false"` unmarks.
- **A way to reach them.** `contact: async () => ({ email, phone, handle })` gives what the app already knows, so whoever fixes it can say thanks or ask a question. It goes by default to a private repo and is off, with the reason ("this repo is public, so anyone could read it"), for a public one. It travels as `who.contact`, the one place a report may carry an email. The receiving side treats it as the person saying "share it" and takes the address itself from the host (the server half's `contactOf(member)`, a relay's `identity()`), so a phone can never put someone else's address on an issue.

The issue carries it all in a "Context (shared so this can be fixed)" table of what, value and why (in place of the About line), the trail in collapsible blocks, and a "Reach them" section with `mailto:` and `tel:` links "To thank them or ask a follow-up question". When the body would pass GitHub's limit, the trail is cut first (oldest taps, then pages, then errors), then the transcript.

**Where it files.** With the optional `destination()` adapter, answering `{ repo, public, account, attaches, name? }`, that line becomes the list of exactly what the issue will carry ("your words · your voice note and its transcript · 2 screenshots, saved to the suggestion-attachments branch of acme/notes · this screen (Photos, /photos) · notes 1.2.3 · iPhone, 390x844 · the time · your name, Alex Kim"), the repo it files on, who can read it there (a public repo says so in `--sac-danger`), and whose GitHub account files it. The list follows the draft as things are added or removed, and it is built by `whatGoes` from `./github`, the same pieces `composeIssue` writes the body from, so the sheet and the issue cannot drift. `attaches: false` says files wait until the repo can take them. With `via: "relay"` (and `relayApp`, the relay's app name as people see it) the account line says the issue is opened by that app and whose it is ("Opened by the Supersuit Suggestions app on GitHub, which says it came from Alex Kim."), since the filer's own account is not what opens it. Sending is the consent. Without the adapter (or when it answers null) the sheet keeps the one line.

**The app's own note.** `words.text.destinationNote` is a sentence or two only the app can say about where a report goes and what it carries ("The people who fix this are outside your family. A photo or video of your child goes too, and a video keeps where it was filmed."). The sheet shows it under the list (or under the one line, without a destination), before Send, in the module's styling (`.sac-note`), and never instead of the list. It is a word rather than a field of `destination()` because every word a person reads lives in `words.text`, where an app already keeps its consent sentence (`goesTo`, `includes`) and translates it, and because it has to show whether or not `destination()` answers: an app that turns `destination()` on keeps its note. My suggestions and the detail view link the issue a report became ("Issue #7"); a member who cannot read the repo still sees the number and the state.

**Identity.** Every screen asks `adapters.identity()` when it mounts, whenever it is handed a different `adapters` object, and whenever the host calls `refreshIdentity()` (exported from `"./client"`; call it after a sign-in, sign-out or account switch). When the account differs, the old account's rows leave the screen and its waiting reports stay on the phone, to be sent only while that account is signed in; every send re-confirms the account first. Keep `adapters` stable where you can; a parent that rebuilds it every render is safe, only slower (one `identity()` call per render).

**Telling the person in the app, with no setup.** The entry asks `mine()` once when it mounts and compares each report's status with the one this account last opened (kept on the phone beside the cached views, per app and account, and cleared on sign-out). A report that has since been filed or closed (`TOLD`) shows a dot on the entry, says New on its row in My suggestions, and the newest such move gets one toast per page load in the module's words (`words.text.movedToast`, given the status's own word and, on `not-planned`, the reason: "Your suggestion: Done", "Your suggestion: Not planned. too big for now"). Opening the report clears it. A report this phone sees for the first time is recorded silently, so an app taking this release does not announce every old report. The list's `not-planned` rows carry their one-line `note` for this. Out of the app, the server's `tellSubmitter` does the telling (below).

**When the entry sits in a menu.** A host that shows the entry inside a menu that stays closed (a three-dot menu, often remounting its rows on every open) would never show the dot, and the toast would be drawn inside the closed menu. Mount `<SuggestNews>` once at the app's root, always mounted: it asks `mine()` when it mounts, shows the page load's one toast with no entry on screen, and keeps the outbox moving. Put the dot on the menu's own trigger with `useSuggestNews(adapters)`, which returns `{ moved }`, and `<SuggestDot>`, which draws the entry's dot (nothing when `moved` is 0). The trigger needs `position: relative`; the class `sac-dot-host` does it. The toast is once per page load and account however many times the entry mounts, whichever of these asks first, and only for a move the previous page load had not already seen: older news keeps the dot and the New mark without a toast. The entry in the menu keeps its own dot.

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
  github: { repo: "acme/notes", token, attachments },     // optional: file each complete report as an issue from here (below)
});
```

**Telling the person who suggested it is required.** `tellSubmitter` is called once when a report becomes an issue (`open`) and once each time it closes or reopens (`done`, `not-planned`, `open`; the list is exported as `TOLD`), with `{ member, reportId, status, words, meaning, ended, note?, issue? }`. `words` and `meaning` are the module's own words for the status (`wordsFor`/`meaningFor`, with `app.owner` as the owner's name when given), never the report's text, so a lock screen never shows what someone wrote; `note` is the one-line reason and comes with `not-planned` only; `issue` is `{ repo, number, url }` once there is one. Being held tells nobody, a repeat of a status tells nobody, a move the store refused tells nobody, and a maintainer is not told that the issue they just filed from their own report exists (its close is still told).

**Roughly where they were, with no prompt.** `geo: (req) => ({ city, region, country })` adds one context item ("Roughly where they were") from the request, on the server half and on a suggestion relay alike; a place the phone claims is dropped. The host already puts it in headers:

```ts
// Vercel
geo: (req) => ({ city: decodeURIComponent(req.headers.get("x-vercel-ip-city") ?? ""), region: req.headers.get("x-vercel-ip-country-region") ?? "", country: req.headers.get("x-vercel-ip-country") ?? "" }),
// Cloudflare (cf-ipcity and cf-region need the "Add visitor location headers" managed transform)
geo: (req) => ({ city: req.headers.get("cf-ipcity") ?? "", region: req.headers.get("cf-region") ?? "", country: req.headers.get("cf-ipcountry") ?? "" }),
```

The handlers keep a report's `context` (the contract checks its shape) and show it back to the member who sent it. **How to reach them comes from the host:** `contactOf(member)` answers what the app knows; the phone only says whether to share it, by sending `who.contact` while the person leaves it ticked, and what it sent there is ignored. Without `contactOf` no report carries a contact, and one of the wrong shape is dropped.

**Filing from the app's server.** With `github: { repo, token, attachments?, people?, nameOf?, fetch? }` the handlers file each report as an issue the moment it is complete: at submit when it has no files, else when its last file is verified. One caller files it (the approval is taken under a one-time name and the report read again under it). The privacy catch runs first; a hit moves the report to `held` with the kinds found (`flags`, never the words, never in the member's view) for the owner to decide. The files are read back through the store's own read links and saved with `attachments` (a `branchHost` with a token that can push, usually); the issue is opened first, then the files saved, then their links edited in. GitHub failing leaves the report `received` and the approval free, so a maintainer's Mac can file it. `app.name` and `app.label` (the host's own) name the app and its `app:<label>`; `nameOf(member)` gives the name the issue says; the member key never appears in an issue. Send it on the app's own channel (push, email, an activity row) to that member only. A failure never fails the move. `createReportHandlers` throws at startup when `tellSubmitter` is missing; an app that genuinely has nobody to tell passes `tellSubmitter: { none: "only the maintainer uses this app" }`, and an empty reason throws too. The `tell` event for a status move now also carries `member` and `status`.

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
| `POST /api/agent/reports/:id/status` | `agentStatus` | body `{ status, step?, note?, issue? }`: 200, 400 (not a status, an old status, a bad issue, or open with no issue), 409 |

A client adapter's `uploadPart` asks `upload-url`, PUTs the bytes straight to storage, then calls `finalize`. Nothing is uploaded through the app's server and no handler reads a body over about 400 KB (sized from the field limits at four bytes a character; far under 4 MB).

The role stored on a report comes from the signed-in member and the `maintainers` list. A `who` sent by the phone is ignored; a report carrying `timeline`, `status`, `plan`, `decision` or `issue` is refused. Settling (`agentSettle`) moves the files under `collected/` and leaves the status alone: collecting is not filing. `sniffType(firstBytes)` names a file by its bytes (jpeg, png, webp, heic/heif, gif, mp4/mov, webm, m4a/aac, mp3, wav, ogg/opus; anything else is `null`) and `finalize` refuses a file whose bytes are not the type it was declared as.

**A wrapper of your own answers in the module's words.** When an app's route has to check a caller or read one field before the handler runs, it uses the same door the handlers use: `json(status, body)` (JSON, never cached), `signIn()` (401) and `notFound()` (404), `cappedText(req, cap)` (the body as text, or a 413 `Response` past `cap` bytes, by the declared length and again by counting what arrives; no body reads as `""`), and `peek(text)` (a JSON object, or `{}` for anything else, for reading one field while the module judges the body). Copying these into an app made a second door that could drift from the first.

**Settle carries a revision.** `agentList` gives each report a `revision`; the Mac sends it back with `settle`, and the store settles only if the report still has exactly that content. A follow-up or file that arrived in between answers 409 `stale`, drops the claim, and the next list offers the report with the addition. Adapters compute the same value with `reportRevision`.

**The collector MUST verify.** `agentFile` answers the verified `bytes` and `sha256`; a Mac that downloads the link must check both before it trusts the file.

**The approval.** Holding a report (`held`) needs no claim. Leaving `held`, filing (`open`) and closing need the Mac that holds the approval (taken atomically if nobody holds it, otherwise 409 with who does). Before it is filed the holder can release it, and an unrenewed approval lapses after seven days. Once it is filed or closed it does not lapse: that move names the maintainer on its timeline entry (`holder`, never shown to the member), the approval is taken for `HELD_MS`, and another Mac asking is answered 409 with that holder. A claim on a closed report is 409 `{ closed: true, status, claimedBy }` for everyone and writes nothing; only a move back to `open` (GitHub reopened it) is taken, by the Mac that filed it or by anyone when nobody is named. The owner may decline (`not-planned`) from `received` or `held`; that entry's actor is the owner, not GitHub.

**What a storage adapter implements** (`HostedStore`). Every method that changes a report is narrow and atomic: `put` is create-only (`created`, `exists`, or `limit` when the member's day is full, counted in the same transaction), and `setFile` (never replaces a verified entry; an older pending never replaces a newer one), `addFollowUp` (the caps, a reused file name and an ended report are checked inside the write), `setStatus(expectFrom)`, `claimApproval`, `claim`, `settle` and `reopen` each change one thing. A real adapter implements these with a transaction or a precondition, never "read the report, change a copy, write it back": that rolls back a status or a claim written in between. Upload links must be create-only and one-time with the size and type fixed in their conditions (a Firebase or S3 signed PUT with `if-generation-match: 0` or `If-None-Match: *`), `discard` must delete a refused object, and `readUrl` links must expire after `ttlMs`.

**Every adapter must pass the conformance suite**, against the adapter and its real storage:

```ts
import { runStoreConformance } from "@supersuit/suggest-a-change/server";
await runStoreConformance(() => ({ store, now, advance, putViaLink, getViaLink, objectKeys }), { test }); // the runner's own `test`
// putViaLink / getViaLink do what your storage service does with a PUT on an upload link and a GET on a read link.
```

## Suggestions as GitHub issues (`./github`)

Zero runtime dependencies, web-standard `fetch` (pass your own as `fetch` anywhere). It turns a report into one plain GitHub issue that can be triaged like any other bug or feature request, from an app's server or from the owner's own machine with `gh`'s token.

```ts
import { privacyCatch, redact, mayFileAsIs, composeIssue, whatGoes, fileSuggestion, attachPending, branchHost, relayHost, issueStates, issueStatus, addFollowUp } from "@supersuit/suggest-a-change/github";

// 1. Nothing is filed before the privacy catch has run over the words, the transcript and the follow-ups.
const { hits } = privacyCatch({ ...report, transcript }, { people, secrets: [senderKey] });
// hits: [{ kind: "credential" | "email" | "phone" | "person", text, field }]. Any hit: hold it for the owner.
// mayFileAsIs(hits) is false when a credential is among them: that one only ever files as redact(report, hits).

// 2. The issue first (saying what is being added), then each file against it, then the links edited in.
const filed = await fileSuggestion({ repo: "acme/notes", token }, {
  report,                                                       // redacted, if the owner chose that
  compose: { appName: "Notes", appVersion: "1.2.3", filerName: "Alex Kim", filerRole: "member", transcript },
  files: [{ name: "image-1.png", type: "image/png", bytes }],   // the report's own file names
  attachments: branchHost({ repo: "acme/notes", token }),       // or relayHost(...) for a filer who cannot push
});
// { number, url, attached: { "image-1.png": url }, pending: [] }
// A file that failed stays in `pending`, and the issue keeps saying it is being added. Retry it later:
await attachPending({ repo: "acme/notes", token }, { number: filed.number, report, compose, files, attachments, attached: filed.attached });

// 3. Follow-ups are comments; the person's status is the issue's own.
await addFollowUp({ repo: "acme/notes", token }, filed.number, "one more thing");
const states = await issueStates({ token }, [{ repo: "acme/notes", number: filed.number }]); // one GraphQL call
issueStatus(states[0]); // "open" | "done" | "not-planned"; a closed issue's `reason` is its last comment's first line
```

- `composeIssue(report, { appName, appVersion, filerName, filerRole, attachmentUrls, transcript, pending })` answers `{ title, body, labels, carries }`. The title is the first sentence of the words (else the transcript), at most 70 characters, else "Suggestion from <app>". Labels are GitHub's own (`enhancement`, `bug`, `feedback`) plus `app:<slug>`. The body's sections are What they said, Voice note, Screenshots (pictures inline, videos and recordings linked), Where, About and Filed by, which ends `Report <id>.`, exactly: a relay requires that as the last line, under `## Filed by`, before it saves a file. **Nothing a report brings can render as markup:** the words, the transcript and follow-ups sit in a fence longer than any backtick run inside them, and every single-line string (where, the context, the trail, names, the handle) has its HTML and markdown escaped, `@` mentions and `#123` references broken with a zero-width joiner, so it pings nobody and links nothing. The only images are attachment links the host produced, and only plain `https` ones. The body never carries the sender's key or an email outside Reach them, and stays under GitHub's limit (`BODY_LIMIT`) by cutting the transcript, with a note. Any file without a link yet is written as "being added"; `pending: true` writes every file that way.
- `whatGoes(draft, destination)` is the sheet's list, one item per piece of `carries`, and `destinationWords(destination)` its headline, privacy line and account line.
- `fileIssue`, `updateIssue`, `addFollowUp` are the REST calls; `fileIssue` creates missing labels first and skips one it may not create (a read-only filer; GitHub then keeps only the labels they may set).
- `AttachmentHost` is `{ put({ repo, issue, reportId }, { name, type, bytes }) -> { url } }`. Every file goes to `attachments/<report id>/<file>` on the repo's own `suggestion-attachments` branch (made the first time, as an orphan sharing no history with the code), linked as `https://github.com/<repo>/blob/suggestion-attachments/<path>?raw=true`, which renders for exactly the people who can read the repo. `branchHost({ repo, token })` writes with a token that can push. `relayHost({ url, headers })` sends the file to an attachment relay (below) with whatever header your relay checks, for the many filers who can open an issue but cannot push.

### Run your own suggestion relay

A relay is one route on a server you run. It acts as a GitHub App you own, and your repo trusts nobody else's server. It does four things, chosen by the **last segment of the path** it is mounted on: `.../file`, `.../follow-up`, `.../status` and `.../attach`, each a POST with a JSON body. Any other last segment is 404.

1. **Create the GitHub App** (Settings, Developer settings, GitHub Apps, New GitHub App). Repository permissions: **Contents: Read and write** and **Issues: Read and write**, nothing else. No webhook is needed. Generate a private key (GitHub gives you a PKCS#1 `.pem`; the relay takes that or PKCS#8) and note the App ID.
2. **Install it** on each repo suggestions file to. Uninstalling it stops every write at once; the issues and files already made stay in the repo.
3. **Mount the handler.** In a Next.js app (app router), one dynamic route serves all four actions, `app/api/suggestions/[action]/route.ts`:

```ts
import { createSuggestionRelay } from "@supersuit/suggest-a-change/github";

const relay = createSuggestionRelay({
  app: { id: process.env.SUGGESTIONS_APP_ID!, privateKey: process.env.SUGGESTIONS_APP_KEY! },
  identity: async (req) => {
    // Whoever your app already knows: a session cookie, an API key in the authorization header. Null refuses.
    const user = await userFromRequest(req);
    // The issue says it was filed by `name`, with `role`, and shares `contact` if the person ticked it.
    // None of these is ever taken from the request.
    // githubLogin: the login this person files under, when you know it; attaching to an issue they opened themselves needs it.
    return user ? { account: user.id, name: user.displayName, role: "member", githubLogin: user.github, contact: { email: user.email } } : null;
  },
  repos: async (account) => ["acme/notes"],          // optional: where this identity may file; null means any repo the App is on
  apps: { notes: { name: "Notes", label: "notes" } }, // the apps it files for: a request names one by id, and the issue's name and app:<label> come from here
  staging,                                            // optional: a bucket for files past a request body limit (below)
  privacy: { people: await thirdParties() },          // optional: names the privacy catch looks for, and any secrets you know
  // limits: { perPersonPerDay: 10 },                 // may lower any limit, never raise one
  usage: myDatabaseUsage,                             // see below
});

export const POST = relay;
export const GET = relay; // GET .../capabilities: what this relay can take, so a filer knows before it sends
```

4. **Point the filers at it:** `relayFiler({ url: "https://your.app/api/suggestions", headers: { authorization: `Bearer ${apiKey}` } })` for filing, following up and reading state, or `relayHost({ url: "https://your.app/api/suggestions/attach", headers })` for attaching to an issue the filer opened themselves.

**The usage store.** `usage` remembers the daily counts, which identity filed which issue, and each report's filing (so a repeat answers the same issue). The default, `memoryUsage()`, lives in memory and is right for **one server instance only**: on a host that runs several instances, or restarts, the caps, the idempotency and who-filed-what are lost or split between instances. Implement `RelayUsage` on your database for anything else. Each method must be ATOMIC, because the check and the change it guards are one step: `reserve(account, day, reportId, bytes, limits)` holds a day's report count and bytes for one request before any work starts (two requests at once can never both pass a cap of one), `commit` keeps it, `release` gives it back when the request fails; `bind(repo, reportId, account)` makes a report belong to the first identity that files or attaches for it; `begin(repo, reportId, account, leaseMs)`, `finish` and `abandon` make filing once per report, under a lease another try takes over once it runs out (its process died); `stage`, `staged` and `unstage` remember what `upload-url` gave a link for, so a staged read never goes past it; `filer` answers who filed an issue.

### Files past a request body limit: staging

Serverless hosts cap a request body (Vercel at about 4.5 MB), so a relay takes a file inside a request only up to `limits.inlineBytes` (3 MB by default). For anything larger, give it a `staging` adapter, a bucket it controls:

```ts
const staging = {
  // A one-time signed PUT that can only create `key` once, with this type and at most these bytes.
  // Google Cloud Storage: a V4 signed URL for PUT with x-goog-if-generation-match: 0 and
  // x-goog-content-length-range: 0,<bytes> signed. S3: a presigned PUT with If-None-Match: * and the
  // content type and length signed. Answer the headers the PUT must send.
  uploadUrl: async (key, { type, bytes }) => ({ url, headers: { "content-type": type, "x-goog-if-generation-match": "0" } }),
  read: async (key) => objectStreamOrNull(key),   // a ReadableStream, Uint8Array or ArrayBuffer, or null when nothing arrived
  discard: async (key) => deleteObject(key),       // once the relay has written it to GitHub
};
```

The filer asks `upload-url` `{ repo, reportId, name, type, bytes }` for each large file (bound to that identity and report like a filing, with the day's bytes held there and then), PUTs the bytes to the link it gets for `staging/<account>/<report id>/<name>`, and names the file in `file` or `attach` as `{ name, type, staged: name }`. The relay reads the staged object, sniffs its bytes, writes it to the branch through the git data API (a blob, a tree, a commit; the contents API is only used under 1 MB), then discards it. `relayFiler` does all of this itself for any file over 2 MB when the relay's `GET .../capabilities` says it stages. Without staging, a file over `inlineBytes` is refused in words before anything is filed (`relayFiler` refuses it before it sends), and a sheet whose `destination()` answers `maxInlineBytes` names such a file in its list before Send: "it does not reach the issue".

### Filing for people with no access

Someone who cannot read the repo can still suggest a change, with every screenshot and recording. Their machine sends the whole report to the relay's `file` action, and the relay files it:

```ts
import { relayFiler, fileSuggestion } from "@supersuit/suggest-a-change/github";

const relay = relayFiler({ url: "https://your.app/api/suggestions", headers: { authorization: `Bearer ${apiKey}` } });
// With no token, or one that cannot see the repo (canFileDirectly is false), fileSuggestion files through the relay;
// with one that can, it files directly as before. `via` says which.
const got = await fileSuggestion({ repo: "acme/notes", token: maybeToken, relay, app: "notes" }, { report, compose: { appName: "Notes", appVersion: "1.2.3", filerName: "Alex Kim", transcript }, files });
// { number, url, via: "relay" | "direct", attached, pending }
await relay.followUp({ repo: "acme/notes", number: got.number, reportId: report.id, words: "one more thing" });
await relay.status([{ repo: "acme/notes", number: got.number }]); // [{ repo, number, status: "open" | "done" | "not-planned", reason? }]
```

- **`file`** `{ repo, app?, report, transcript?, files: [{ name, type, bytes (base64) } | { name, type, staged: name }], redacted? }` answers `{ number, url }`. The relay checks the report against the contract and each file against what the report declares, runs the privacy catch itself, saves the files to `suggestion-attachments`, then opens the issue **as the App**, filed by the name `identity()` gives (never the account id, and never a name in the request), with the role and the contact from `identity()` too and the app's name and `app:<label>` from the relay's `apps` table by the request's `app` id (an id not in the table is 400 "unknown app"; with no table no request names an app, and the issue says "in an app" with no app label); the contact only when the report carries `who.contact` (the person left it ticked). At most ten labels. A credential refuses with 422 naming the kind and the field, never the text, whatever `redacted` says. Any other hit refuses with 409 `{ held: true, hits: [{ kind, field }] }` until the filer sends again with `redacted: true`, saying they chose to file without the flagged part; the relay then redacts what it found itself, so raw text is never filed on the filer's word. The catch reads every string that would reach the issue (where, every diagnostic, the context, the trail, the names, the handle), after folding look-alike letters and removing invisible characters. A repeat of the same report answers the same issue; another identity using that report id is 409.
- **`follow-up`** `{ repo, number, reportId, words, transcript?, files?, redacted? }` adds a comment, only for the identity that filed that report through this relay (anyone else, 403). The same privacy catch runs.
- **`status`** `{ items: [{ repo, number }] }` answers `{ items: [{ repo, number, status, reason? }] }`, only for issues this identity filed (anything else, 403).
- **`attach`** is for a filer who opened the issue themselves but cannot push. Reading the issue is the proof they could file there: it must exist, be an issue, be open or closed within a week, and END with the composer's own `## Filed by` line for that report ("Report <id>" anywhere else proves nothing). And a report belongs to the first identity that files or attaches for it: anyone else attaching to it is 403. An issue the relay filed takes files only from the identity that filed it; an issue someone opened themselves takes them only when its author's login is the `githubLogin` that `identity()` vouches for, and nothing is claimed until that proof holds. A request lists each file once and no more of each kind than a report may carry; a follow-up is composed and measured before any file is written, and holds to the report's caps like `attach`.

On every call the relay refuses, and each refusal has a test: anything but POST (405); an action it does not have (404); a caller `identity` does not know (401); a repo `repos` does not allow for that identity (403, "this account may not file on <repo>"); a malformed repo, number, report id, file name, base64 body or report, or a file the report does not declare (400); bytes that are not an accepted picture, video or recording, or not the type declared, judged by the bytes (422); a file over the size caps (413); a repo the App is not installed on (403, "the app is not installed on <repo>"); a credential (422) or another privacy hit (409, held); a follow-up or status request for an issue another identity filed (403); for `attach`, an issue that does not exist (404), is a pull request, does not carry the report, or closed more than a week ago (403), a path already written (409), or a report holding all the files it may (422); and more reports, or more bytes, in a day than one identity's cap (429). It writes only `attachments/<report id>/<file>` on `suggestion-attachments`, with an installation token scoped to the one repo. A host that limits request bodies (several serverless platforms stop at a few MB) also limits what the relay can take: a report with a long video needs a route that accepts a body that large.

## What is here, and what is coming

| Export | State |
| --- | --- |
| `"."` the report contract | here |
| `"./client"` ids, drafts, the report outbox and the recorder | here |
| `"./client"` the toast, entry, sheet, receipt, My suggestions and detail (React 19, optional peer) | here |
| `"./styles.css"` optional defaults | here |
| `"./check"` and the `suggest-a-change-check` and `suggest-a-change init` commands | here |
| `"./server"` the receiving side: handlers, store conformance suite, byte sniffing | here |
| `"./github"` suggestions as issues: privacy catch, issue body, filing, attachment hosts, your own suggestion relay | here |

Each export is added to `package.json` in the same change as its code, so nothing here points at a file that does not exist.

## Status

Version 0.1.0 is the first release and is published once by its owner (the first publish of a new package name cannot be a tag push). Every release after that is a pushed `v<version>` tag (GitHub Actions, npm trusted publishing). Below 1.0, additions are patch versions, so apps take them without a change; a change to the statuses is a minor version (0.2.0 moved them onto GitHub's), which an app on `^0.1` takes on purpose.

## License

MIT
