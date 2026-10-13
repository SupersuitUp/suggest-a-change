# @supersuit/suggest-a-change

The report format and flow behind a Suggest a change button: what a report is, who acts at each step, and the checks every app runs. Zero dependencies.

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

The client core is TypeScript, built to `dist/` with declarations:

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

The entry carries `data-suggest-entry` (the attribute the screen check looks for). Signed out, it opens nothing and says why. The receipt says "Got it" only after the adapter has answered `done` for the report and every attachment; until then it says the report is on the phone. Every text field the module renders sits in a `[data-voice-field]` container with a `[data-voice-control]`; a host's `Field` slot must keep that shape (it receives `FieldProps`, which is the Helm's voice field props). A voice note alone is a whole report: the recording is kept and uploaded as a part, and the receiving Mac writes the transcript.

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

Check it (typecheck, client tests, build, node tests, the command):

```bash
npm ci
npm run check
```

Development needs Node 22 or newer (vitest and jsdom); the built package runs on Node 20 and up.

## What is here, and what is coming

| Export | State |
| --- | --- |
| `"."` the report contract | here |
| `"./client"` ids, drafts, the report outbox and the recorder (no React) | here |
| `"./client"` the toast, entry, sheet, receipt, My suggestions and detail (React 19, optional peer) | here |
| `"./styles.css"` optional defaults | here |
| `"./server"` the receiving side | coming |
| `"./check"` and the `suggest-a-change-check` command, which fails an app whose screens lack the button | coming |

Each export is added to `package.json` in the same change as its code, so nothing here points at a file that does not exist.

## Status

Not published yet. Version 0.1.0 is the first release and is cut by its owner, then every release after is a pushed `v<version>` tag (GitHub Actions, npm trusted publishing).

## License

MIT
