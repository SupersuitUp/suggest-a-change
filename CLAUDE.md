# CLAUDE.md

Standing rules for `@supersuit/suggest-a-change`. The README is the full reference; this holds only rules an agent changing the sheet must not miss.

- The sheet's list of what a suggestion carries is folded by default: one line says where it files (public always shown, never folded), and the itemized list with its checkboxes opens on tap (the operator, 2026-10-26: 'it's a little bit disturbing with all the checkboxes shown').
- Every word a person reads lives in `src/client/words.ts` and is replaceable through `words.text`.
- The sheet's list and the issue body are built from the same pieces (`whatGoes` and `composeIssue`); the parity test in `test/client/screens.test.tsx` must keep passing.
- Releases are a tag push (`vX.Y.Z`) through the publish workflow; bump `package.json`, `package-lock.json` and `CHANGELOG.md` together.
- This repo is public: no real people's names, emails or private repos in fixtures or docs.
