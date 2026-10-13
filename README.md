# @supersuit/suggest-a-change

The report format and flow behind a Suggest a change button: what a report is, who acts at each step, the screens, and the check every app runs. The contract (the package root) has zero dependencies.

## 30 seconds

```bash
npm install @supersuit/suggest-a-change
```

```js
import { KINDS, STATUSES, FLOW, CEILINGS } from "@supersuit/suggest-a-change";

console.log(KINDS);            // ["change", "broken", "feedback"]
console.log(FLOW["with-freeda"]); // { actor: "mac", next: ["planned"] }
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
};
// On every screen below home:  <SuggestEntry adapters={adapters} onOpen={() => setOpen(true)} />
// then:                        {open && <SuggestSheet adapters={adapters} where={{ screen: "Photos", route: location.pathname }} onClose={() => setOpen(false)} />}
```

The entry carries `data-suggest-entry` (the attribute the screen check looks for; see "The check" below). Signed out, it opens nothing and says why. The receipt says "Got it" only after the adapter has answered `done` for the report and every attachment; until then it says the report is on the phone. Every text field the module renders sits in a `[data-voice-field]` container with a `[data-voice-control]`; a host's `Field` slot must keep that shape (it receives `FieldProps`, which is the Helm's voice field props). A voice note alone is a whole report: the recording is kept and uploaded as a part, and the receiving Mac writes the transcript.

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

The four diagnostics are the app's version, the time, the screen size and the phone type; the app's version and the phone type are on by default and the time and screen size are off (the report's id and the app's own received time already say when it was sent), and the screen's name and address are always sent and shown as such.

**Identity.** Every screen asks `adapters.identity()` when it mounts, whenever it is handed a different `adapters` object, and whenever the host calls `refreshIdentity()` (exported from `"./client"`; call it after a sign-in, sign-out or account switch). When the account differs, the old account's rows leave the screen and its waiting reports stay on the phone, to be sent only while that account is signed in; every send re-confirms the account first. Keep `adapters` stable where you can; a parent that rebuilds it every render is safe, only slower (one `identity()` call per render).

**Follow-ups.** Words and voice notes added to a report afterwards are queued in the outbox like the report (a `followUp` write, then one part per voice note), keep the app's refusal with a Try again, and delete their local copy only once they have landed. `StoreAdapter.append` must therefore dedupe by report id and `more.followId`.

## The check: every screen carries the button

`suggest-a-change-check` fails an app whose screens lack the Suggest a change entry, or whose adapters are not all supplied. Each app calls it from its own check script. Run it from the app's folder:

```bash
npx suggest-a-change-check
npx suggest-a-change-check --help
```

Exit 0 is clean, 1 is problems (each printed with the file and the fix), 2 is a usage error or nothing to check. `--json` prints `{ ok, problems, checked, exempted }`. The flags are `--repo`, `--config`, `--app-dir`, `--adapters` and `--strict`. An app directory with no pages is a usage error (exit 2: nothing was checked), as is an app directory outside the repo.

**Put `suggest-a-change-check --strict` in the app's check script** once the adapters are real. `init` writes stubs that sign nobody in and refuse every report, and marks the file with a `suggest-a-change: STUB` line. Without `--strict` that line is a `warning:` (also in the `--json` `warnings`) and the exit stays 0; with `--strict` it is a problem and the exit is 1. Delete the line when the four adapters are real.

For a Next.js app (app router) it reads source, not a running app:

- It takes the same screen list the home-screen check takes (see "The screen list" below): every page under the app directory (`appDir` in `home-screen.json`, else `src/app`, else `app`), minus the routes listed under `home` (default `/`).
- A screen passes when its page, or any layout or template from the app directory down to the page's own folder (nested layouts and route groups included), renders `<SuggestEntry` or carries `data-suggest-entry` as a JSX element or attribute. The entry may come through a component the file imports, but only if the file actually renders that import (`<Shell>` must appear as an element in the importing file; importing it is not enough). Relative, `@/` and `~/` imports and re-exports are followed three levels deep. A match inside a string literal, a comment or a template string does not count; JSX text is text, so an apostrophe in it starts nothing.
- A screen that should not have the button is listed in the same config file, with a reason:

  ```json
  { "home": ["/"], "suggest-a-change": { "exempt": { "/share/[token]": "opened by someone who is not a member" } } }
  ```

  An exemption with an empty reason, or for a route that no longer exists, is a problem.
- The adapters file (`tailor/suggest-a-change.ts`, or the path under `"suggest-a-change": { "adapters": "..." }`) must export all four of `identity`, `store`, `words` and `limits`, directly or through `export *` and `export { x as y }` from a local file.

What it cannot see: an entry rendered only under a condition, which component inside an imported file renders the entry (it checks the file), a component reached through more than three levels of imports, an import through a path alias other than `@/` and `~/`, an entry that code builds from a string, and a regular expression literal containing a quote, which can confuse its reading of the rest of that file. It reads text, so it will say a screen is covered when the entry exists in the source and never shows at runtime. Keep the entry unconditional (a signed-out visitor is told why by the entry itself).

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

## What is here, and what is coming

| Export | State |
| --- | --- |
| `"."` the report contract | here |
| `"./client"` ids, drafts, the report outbox and the recorder | here |
| `"./client"` the toast, entry, sheet, receipt, My suggestions and detail (React 19, optional peer) | here |
| `"./styles.css"` optional defaults | here |
| `"./check"` and the `suggest-a-change-check` and `suggest-a-change init` commands | here |
| `"./server"` the receiving side | coming |

Each export is added to `package.json` in the same change as its code, so nothing here points at a file that does not exist.

## Status

Version 0.1.0 is the first release and is published once by its owner (the first publish of a new package name cannot be a tag push). Every release after that is a pushed `v<version>` tag (GitHub Actions, npm trusted publishing). Below 1.0, additions are patch versions, so apps on `^0.1.0` take them without a change.

## License

MIT
