# Changelog

## 0.1.0 (unreleased)

First release. The report contract and flow map: kinds, roles, ceilings, statuses, who acts at each step, and report validation.

The client core, exported as `./client`: IndexedDB store, op ids, the outbox (`Op.kind` is a string the host names; the module adds `report` and `reportPart`), the take recorder with crash recovery, drafts keyed `sac:<app>:<account>`, and the report sender over a `StoreAdapter`. Built to `dist/` with type declarations.
