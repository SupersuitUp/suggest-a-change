# Changelog

## Unreleased

## 0.1.11 (2026-10-18)

- **A second tab no longer takes over the first tab's recording.** Two tabs share one IndexedDB, and a tab that opened while another was recording ran `recoverTakes` over the live take: it deleted its marker and chunks, so every second said after that had no marker and was lost if the recording tab then died (freedom-app-template#1). Each second of a take now refreshes `beatAt` on its marker, and `recoverTakes` leaves a take that beat within `LIVE_TAKE_MS` (5 s, exported) exactly as it is; it is made whole on an open after it goes quiet. `recoverTakes(store, claim, { now, liveMs })` takes the clock for tests. An app reopened within 5 s of a crash recovers that take on its next open instead of this one; nothing is lost.

## 0.1.10 (2026-10-17)

- **What goes with it is one small line.** The sheet no longer draws a section with a legend, an explainer and four switches above Send. Every diagnostic (the app's version, the time, the screen size, the phone type) goes with every report, beside the screen's name and address, and one muted line says what goes and to whom. Whoever acts on a report needs all of them, so leaving one out only ever cost a round trip. The `Words` keys the switches used (`withLegend`, `alwaysSent`, `include`, `screenName`) stay, so an app that overrides them still typechecks.

## 0.1.9 (2026-10-17)

- **The door helpers are exported from `./server`.** `json`, `signIn`, `notFound`, `cappedText` and `peek` are what an app's own route wrapper needs to answer as the handlers do and never read a body past a cap. Two apps (cofounders-template, first-years-template) carried byte-identical copies; they now import these. The handlers use the same functions, so there is one copy of the door. No behaviour change.

## 0.1.8 (2026-10-17)

- **The news reaches a person whose entry sits in a menu.** In the Cofounders and Us apps the entry lives in a three-dot menu that stays closed and remounts it on every open, so the 0.1.7 dot was never seen and the toast was drawn inside the closed menu. New in `./client`: `<SuggestNews adapters>`, mounted once at the root, shows the toast with no entry on screen (and keeps the outbox moving); `useSuggestNews(adapters)` returns `{ moved }` for the menu's trigger; `<SuggestDot adapters moved>` draws the entry's dot there (nothing at 0), and the class `sac-dot-host` gives the trigger the `position: relative` it needs. The toast is once per page load and account however many times the entry mounts, whichever of these asks first. `<SuggestEntry>` keeps its own dot and, alone, behaves as in 0.1.7.

## 0.1.7 (2026-10-17)

- **The person who suggested a change is told when it is being made and when it ends.** `createReportHandlers` takes a required `tellSubmitter(e)`, called once per move to `being-made` or an end (`TOLD`, now in the contract) with `{ member, reportId, status, words, meaning, ended, note? }`. The words are the module's own (`wordsFor`/`meaningFor`), never the report's text; `note` is the one-line reason, on `not-now` only. The planning steps, a repeat, a refused move and a maintainer's own report starting tell nobody, and a failure never fails the move. **Breaking:** without `tellSubmitter` the handlers throw at startup; an app with nobody to tell passes `{ none: "<reason>" }`. The `status` tell event also carries `member` and `status`, and a `not-now` row in the member's list carries its `note`.
- **In the app, with no setup.** The entry compares each report's status with the one its owner last opened (kept on the phone per app and account, cleared on sign-out): a report that has since started or ended shows a dot on the entry, says New in My suggestions, and the newest move gets one toast per app open ("Your suggestion: Done"; new strings `newMark`, `entryMoved`, `movedToast`). Opening the report clears it. A report seen for the first time is recorded silently, so nothing old is announced.
- `init` writes a `tellSubmitter` stub into the adapters file and names it in its notes.

## 0.1.6 (2026-10-15)

- **Writes made in the same millisecond leave the phone in the order they were made.** `enqueue` stamps each op with `seq`, and the queue sorts by `at`, then `seq`, then id. Before, ties fell to the id, so a screen that saved a draft and then asked for it to be prepared in one tick sent the prepare first about half the time, and the receiver prepared the draft as it had been.

## 0.1.5 (2026-10-14)

- **The agent is Pluma.** Every word a person reads now names Pluma, the agent formerly called Freeda: "With Pluma", "Goes to <owner> and Pluma", "Pluma picks it up". The status key `with-freeda` is unchanged, so stored reports and older clients still read. A copy of the contract vendored elsewhere must be taken again: these are new bytes.

## 0.1.4 (2026-10-14)

- **The owner may decline a report Freeda has not planned.** `FLOW["with-freeda"].next` and `FLOW["planned"].next` now include `"not-now"`, so a report the reading worker cannot plan has an exit instead of showing "With Freeda" for ever. `agentStatus` accepts both moves (they take the approval, as any end does). A copy of the contract vendored elsewhere must be taken again: these are new bytes.
- **A claim on a closed report answers 409 and never lapses.** `claim-approval` on a report at an end status answers 409 `{ closed: true, status, claimedBy }` to everyone and writes nothing; before, the seven-day approval lapsed and an eight-day-old card could take a shipped or declined report. A report being made stays with the Mac that started it: the move to `being-made` or an end now names the maintainer on its timeline entry (`holder`, not in the member's view) and takes the approval for `HELD_MS` (exported), and another Mac is answered 409 with that holder however long after. Before the work starts the approval still lapses after a week.
- **The list never offers a report another maintainer closed.** `agentList` settles such a report for the asking maintainer without showing it, so it neither raises a notice on a second Mac nor fills the head of every page; it asks the store again when that freed slots. A report another maintainer is making carries `heldBy`. A report closed before 0.1.4 names no holder and is treated as closed by someone else.

## 0.1.3 (2026-10-13)

- **The phone's saved answers belong to whoever asked.** A list or report that the app answers after the signed-in account has changed is neither saved under the earlier account's key nor drawn: the account is asked again after the answer, as the outbox does before a write.
- **A refusal is not "could not reach the app".** `mine()` and `one(id)` signal a refusal by throwing an error with `refused: true` or a `status` of 401, 403 or 404 (`one` may also answer an object with a string `refused`). On a refusal the saved copy is deleted and the screen says the suggestion could not be opened (or the list could not be loaded); any other failure keeps the saved copy under the "Could not reach the app" line, as in 0.1.2. Documented on `StoreAdapter`.
- **The detail view follows its `id`.** Changing the id prop resets what is shown, so one report is never drawn under another's address.
- **The saved views are kept tidy.** After a successful list, saved reports the app no longer lists are deleted, and signing out clears the account's saved views from the phone.
- "Updating" shows only until the first answer after the screen opens, not on every periodic reload.

## 0.1.2 (2026-10-13)

- **My suggestions and the detail view draw at once.** Each keeps its last successful answer (`mine()` and each `one(id)`) in the module's own IndexedDB store, keyed by app and account like a draft, and draws it as soon as the phone has read it, with a quiet "Updating" line until the app answers. The app's answer replaces it (a report that vanished on the app disappears). If the app cannot be reached, the saved rows stay and the screen says so: "Could not reach the app. Showing what this phone last saw." A first open with nothing saved shows the loading state, as before. Reports waiting in the outbox show as they did. Another account never reads this account's saved answer. New strings `updating` and `offlineShowingSaved` (replaceable through `words.text`).
- **`<SuggestEntry role>`.** The entry button takes an ARIA `role` (for a host that shows it as a menu row with `role="menuitem"`), beside `className`. Unset by default.

## 0.1.1 (2026-10-13)

- **A report sent with the Mac away is sent when it is back, even with the sheet closed.** The outbox used to move only while the sheet, My suggestions or a detail screen was mounted, so a report waited until the person opened one again. `<SuggestEntry>` now keeps the outbox moving while it is mounted, and `KeepSending` is exported from `./client` for a host with no always-mounted entry (it draws nothing).
- A voice file's upload link now allows 200,000 bytes per second of declared length, so an uncompressed WAV is not refused.
- When finalize refuses a file, the pending entry is removed first and the stored object is deleted only if that removal happened.
- The client test "after Send, focus moves to the receipt" waits for both of its conditions, for longer.

## 0.1.0 (2026-10-12)

First release. The report contract and flow map: kinds, roles, ceilings, statuses, who acts at each step, and report validation.

The client core, exported as `./client`: IndexedDB store, op ids, the outbox (`Op.kind` is a string the host names; the module adds `report` and `reportPart`), the take recorder with crash recovery, drafts keyed `sac:<app>:<account>`, and the report sender over a `StoreAdapter`. Built to `dist/` with type declarations.

The screens, exported from `./client` (React 19 as an optional peer): the entry, the sheet, the receipt, My suggestions and the detail view, a default voice field, and optional styles in `./styles.css`.

The screen check, exported as `./check` and installed as the `suggest-a-change-check` command: it fails an app whose screens below home lack the Suggest a change entry (nested layouts and imported shell components are followed; an exempt screen needs a reason) or whose adapters file does not export all four of `identity`, `store`, `words` and `limits`. `checkEntryOnRoutes` does the same for an app with one shell. `suggest-a-change init` wires a new Next.js app: the dependency, adapter stubs under `tailor/`, the entry in the root layout and the check in the app's check script. The stubs carry a `suggest-a-change: STUB` line: the check warns about it, and `suggest-a-change-check --strict` fails on it, so an app cannot ship the stubs as done.

The server half, exported as `./server`: `createReportHandlers` (submit, upload-url, finalize, mine, one, append, and the agent routes list, file, settle, claim-approval, status), the `HostedStore` an app's storage implements, `runStoreConformance` (the suite every adapter must pass), and `sniffType`. Web-standard APIs only, no runtime dependency. Reports are isolated by member (another member's report answers exactly like a missing one), the stored role is decided by the server, attachments go straight to storage on links with size and type fixed and are verified by their bytes at finalize, the day's limit is twenty at most, a claim lasts ten minutes, and the approval is first-wins and held by the Mac that took it (a week, releasable). The store contract is create-only and narrow (`put`, `setFile`, `addFollowUp`, `setStatus` with a precondition, `reopen`), so a stale write cannot erase a status or a claim, and a follow-up or file that arrives after a Mac collected a report offers it again. Settle carries the revision the Mac was shown, so something added between list and settle is never lost; follow-up caps are enforced inside the atomic write; a verified file entry cannot be replaced; only the owner adds to a report, and not once it has ended; a voice file's link size follows its declared length. The phone refuses a picture or video format the app cannot take, in words, and takes a HEIC with no type by its extension. The conformance suite is proved against deliberately unsafe adapters.

The check is strict about what counts as rendering the entry: an imported component only covers a layout that uses it (as an element, a prop value or a rendered alias), and the imported name (for a namespace import, the member rendered) is carried through barrel files, strings and comments never count, JSX text is not read as code, and an app directory with no pages is a usage error rather than a pass.
