# Changelog

## 0.1.0 (2026-10-12)

First release. The report contract and flow map: kinds, roles, ceilings, statuses, who acts at each step, and report validation.

The client core, exported as `./client`: IndexedDB store, op ids, the outbox (`Op.kind` is a string the host names; the module adds `report` and `reportPart`), the take recorder with crash recovery, drafts keyed `sac:<app>:<account>`, and the report sender over a `StoreAdapter`. Built to `dist/` with type declarations.

The screens, exported from `./client` (React 19 as an optional peer): the entry, the sheet, the receipt, My suggestions and the detail view, a default voice field, and optional styles in `./styles.css`.

The screen check, exported as `./check` and installed as the `suggest-a-change-check` command: it fails an app whose screens below home lack the Suggest a change entry (nested layouts and imported shell components are followed; an exempt screen needs a reason) or whose adapters file does not export all four of `identity`, `store`, `words` and `limits`. `checkEntryOnRoutes` does the same for an app with one shell. `suggest-a-change init` wires a new Next.js app: the dependency, adapter stubs under `tailor/`, the entry in the root layout and the check in the app's check script. The stubs carry a `suggest-a-change: STUB` line: the check warns about it, and `suggest-a-change-check --strict` fails on it, so an app cannot ship the stubs as done.

The server half, exported as `./server`: `createReportHandlers` (submit, upload-url, finalize, mine, one, append, and the agent routes list, file, settle, claim-approval, status), the `HostedStore` an app's storage implements, `runStoreConformance` (the suite every adapter must pass), and `sniffType`. Web-standard APIs only, no runtime dependency. Reports are isolated by member (another member's report answers exactly like a missing one), the stored role is decided by the server, attachments go straight to storage on links with size and type fixed and are verified by their bytes at finalize, the day's limit is twenty at most, a claim lasts ten minutes, and the approval is first-wins.

The check is strict about what counts as rendering the entry: an imported component only covers a layout that uses it (as an element, a prop value or a rendered alias), and the imported name (for a namespace import, the member rendered) is carried through barrel files, strings and comments never count, JSX text is not read as code, and an app directory with no pages is a usage error rather than a pass.
