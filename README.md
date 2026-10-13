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
| `"./client"` the toast and the sheet (React 19, optional peer) | coming |
| `"./server"` the receiving side | coming |
| `"./check"` and the `suggest-a-change-check` command, which fails an app whose screens lack the button | coming |

Each export is added to `package.json` in the same change as its code, so nothing here points at a file that does not exist.

## Status

Not published yet. Version 0.1.0 is the first release and is cut by its owner, then every release after is a pushed `v<version>` tag (GitHub Actions, npm trusted publishing).

## License

MIT
