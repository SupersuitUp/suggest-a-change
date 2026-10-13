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

Check it runs:

```bash
npm test
npx suggest-a-change --help
```

## What is here, and what is coming

| Export | State |
| --- | --- |
| `"."` the report contract | here |
| `"./client"` the recorder, outbox and toast (React 19, optional peer) | coming |
| `"./server"` the receiving side | coming |
| `"./check"` and the `suggest-a-change-check` command, which fails an app whose screens lack the button | coming |

Each export is added to `package.json` in the same change as its code, so nothing here points at a file that does not exist.

## Status

Not published yet. Version 0.1.0 is the first release and is cut by its owner, then every release after is a pushed `v<version>` tag (GitHub Actions, npm trusted publishing).

## License

MIT
