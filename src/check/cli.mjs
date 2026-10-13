// suggest-a-change-check: exit 0 clean, 1 problems, 2 usage. Text in, text out; --json for machines.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { inspectSuggestEverywhere, UsageError } from './index.mjs'
import { parseArgs } from './args.mjs'

export const CHECK_USAGE = `suggest-a-change-check: fails an app whose screens lack the Suggest a change entry.

Usage: suggest-a-change-check [--repo <path>] [--config <file>] [--app-dir <dir>] [--adapters <file>] [--json]

  --repo      the app (default: the current folder)
  --config    the app's config, read the way the home-screen check reads it (default: home-screen.json)
  --app-dir   the Next app directory (default: the config's appDir, else src/app, else app)
  --adapters  the file exporting identity, store, words and limits (default: tailor/suggest-a-change.ts)
  --json      print { ok, problems, checked, exempted } instead of text

Every page below a home route must be under a layout that renders <SuggestEntry>, or be listed in the
config under "suggest-a-change": { "exempt": { "/route": "why" } } with a reason.
Exit 0: clean. Exit 1: problems. Exit 2: bad arguments or nothing to check.`

export function runCheck(argv, { out = (s) => console.log(s), err = (s) => console.error(s) } = {}) {
  const a = parseArgs(argv, { bool: ['--json'], value: ['--repo', '--config', '--app-dir', '--adapters'] })
  if (a.help) { out(CHECK_USAGE); return 0 }
  if (a.error) { err(`${a.error}\n\n${CHECK_USAGE}`); return 2 }
  const repo = resolve(a.values['--repo'] ?? process.cwd())
  const config = a.values['--config'] ?? 'home-screen.json'
  if (a.values['--config'] && !existsSync(resolve(repo, config))) { err(`${config}: no such file`); return 2 }
  let r
  try {
    r = inspectSuggestEverywhere({ repo, config, appDir: a.values['--app-dir'], adaptersFile: a.values['--adapters'] })
  } catch (e) {
    if (e instanceof UsageError) { err(e.message); return 2 }
    throw e
  }
  const ok = r.problems.length === 0
  if (a.flags.has('--json')) { out(JSON.stringify({ ok, problems: r.problems, checked: r.checked, exempted: r.exempted.map(([route, reason]) => ({ route, reason })) }, null, 2)); return ok ? 0 : 1 }
  for (const p of r.problems) out(p)
  for (const [route, why] of r.exempted) out(`exempt ${route}: ${why}`)
  if (!ok) { err(`${r.problems.length} Suggest a change problem(s).`); return 1 }
  out(`Suggest a change holds: ${r.checked.length} screen(s) below the home have the entry or a reason, and ${r.adapters} exports all four adapters`)
  return 0
}
