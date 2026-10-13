// suggest-a-change init: wires an app to the module. Idempotent, and it never overwrites a file that exists.
//   1. adds the dependency          2. writes adapter stubs under tailor/
//   3. adds the check to the package's check script
//   4. writes the wired-up entry component and renders it in the root layout
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname, relative, sep, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appDirFor, UsageError, STUB_SENTINEL } from './index.mjs'
import { parseArgs } from './args.mjs'

export const INIT_USAGE = `suggest-a-change init: wire an app to Suggest a change.

Usage: suggest-a-change init [--repo <path>] [--app <id>] [--owner <first name>] [--json]

  --repo   the app (default: the current folder); needs a package.json and a Next app directory
  --app    a short id for the app, no ":" (default: the package name)
  --owner  the owner's first name as the receipt says it (default: Owner; it is yours to set in tailor/)
  --json   print what was done as JSON

Adds the dependency to package.json, writes tailor/suggest-a-change.ts (kept if it exists), adds
suggest-a-change-check to the check script, and renders the entry in the root layout. Running it again
changes nothing. Then install your dependencies and fill in the adapters (the stubs open nothing).
Exit 0: done. Exit 2: bad arguments or not an app it understands.`

const SELF = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8'))
const NAME = SELF.name
const posix = (p) => p.split(sep).join('/')
const dotted = (p) => (p.startsWith('.') ? p : './' + p)

function writeIfAbsent(path, text, log, label) {
  if (existsSync(path)) { log.kept.push(label); return false }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  log.did.push(`wrote ${label}`)
  return true
}

const stubFor = (app, owner) => `// ${STUB_SENTINEL}. These adapters sign nobody in and refuse every report, so the button opens nothing.
// Fill in the four below, then delete this line. "suggest-a-change-check --strict" fails while it is here.
// The four things this app supplies to Suggest a change; the module owns everything else.
import type { Adapters } from "${NAME}/client";

/** Who is signed in: { account, role } where role is "operator", "member" or "maintainer", or null. */
export const identity: Adapters["identity"] = async () => null; // TODO: read this app's own session

/** Where reports are kept. submit, uploadPart and append must dedupe by report id. */
export const store: Adapters["store"] = {
  submit: async () => ({ refused: "reports are not stored yet" }), // TODO
  uploadPart: async () => ({ refused: "reports are not stored yet" }), // TODO
  mine: async () => [], // TODO
  one: async () => { throw new Error("reports are not stored yet"); }, // TODO
  append: async () => ({ refused: "reports are not stored yet" }), // TODO
};

/** The words: a short app id, and the owner's first name as the receipt says it. */
export const words: Adapters["words"] = { app: ${JSON.stringify(app)}, owner: ${JSON.stringify(owner)} };

/** Attachment limits. May lower the module's ceilings, never raise them. */
export const limits: Adapters["limits"] = {};
`

const componentFor = (adaptersImport) => `"use client";
// The Suggest a change entry and its sheet, wired to this app's adapters. Rendered once in the root layout.
import { useState } from "react";
import { usePathname } from "next/navigation";
import { SuggestEntry, SuggestSheet, type Adapters } from "${NAME}/client";
import { identity, store, words, limits } from "${adaptersImport}";

const adapters: Adapters = { identity, store, words, limits };

export function SuggestChange() {
  const [open, setOpen] = useState(false);
  const route = usePathname() ?? "";
  return (
    <>
      <SuggestEntry adapters={adapters} onOpen={() => setOpen(true)} />
      {open ? <SuggestSheet adapters={adapters} where={{ screen: route, route }} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
`

// Adds a key without re-sorting the others: in its alphabetical place when the existing keys are already
// sorted, at the end when they are not.
function withKey(obj, key, value) {
  const keys = Object.keys(obj)
  const sorted = keys.every((k, i) => i === 0 || keys[i - 1].localeCompare(k) <= 0)
  const at = sorted ? keys.findIndex((k) => k.localeCompare(key) > 0) : -1
  const entries = Object.entries(obj)
  entries.splice(at < 0 ? entries.length : at, 0, [key, value])
  return Object.fromEntries(entries)
}

// The JSX {children}: the last one that is not a destructured parameter (a `{children}` after `(` or `,`, or
// followed by `:` `=` `,`).
function childrenSpot(src) {
  let at = -1
  for (const m of src.matchAll(/\{\s*children\s*\}/g)) {
    const before = src.slice(0, m.index).trimEnd().slice(-1)
    const after = src.slice(m.index + m[0].length).trimStart()[0]
    if (before === '(' || before === ',' || after === ':' || after === '=' || after === ',') continue
    at = m.index
  }
  return at
}

export function initApp({ repo, app, owner = 'Owner' }) {
  const root = resolve(repo)
  const pkgPath = join(root, 'package.json')
  if (!existsSync(pkgPath)) throw new UsageError(`${root}: no package.json, so this is not an app init understands`)
  const raw = readFileSync(pkgPath, 'utf8')
  let pkg
  try { pkg = JSON.parse(raw) } catch (e) { throw new UsageError(`package.json: not readable JSON (${e.message})`) }
  let cfg = {}
  const cfgPath = join(root, 'home-screen.json')
  if (existsSync(cfgPath)) { try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) } catch { cfg = {} } }
  const appDir = appDirFor(root, cfg)
  if (!(relative(root, resolve(root, appDir)) && !relative(root, resolve(root, appDir)).startsWith('..') && !isAbsolute(relative(root, resolve(root, appDir))))) throw new UsageError(`${appDir}: the app directory is outside ${root}, so init will not write there`)
  if (!existsSync(join(root, appDir))) throw new UsageError(`${appDir}: no Next app directory here; init wires the app router (pass nothing else, or create the app first)`)
  const id = (app ?? String(pkg.name ?? 'app').replace(/^@[^/]+\//, '')).replace(/[^A-Za-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'app'
  const log = { did: [], kept: [], notes: [] }

  // 1 + 3. package.json: the dependency and the script, preserving indent and the final newline.
  const indent = /^\{\r?\n([ \t]+)"/.exec(raw)?.[1] ?? 2
  const had = pkg.dependencies?.[NAME] ?? pkg.devDependencies?.[NAME]
  if (had) log.kept.push(`dependency ${NAME}`)
  else {
    pkg.dependencies = withKey(pkg.dependencies ?? {}, NAME, `^${SELF.version}`)
    log.did.push(`added ${NAME}@^${SELF.version} to dependencies (install your dependencies next)`)
  }
  pkg.scripts ??= {}
  const scriptName = ['living:check', 'check'].find((n) => typeof pkg.scripts[n] === 'string') ?? 'check'
  const current = pkg.scripts[scriptName]
  if (typeof current === 'string' && current.includes('suggest-a-change-check')) log.kept.push(`suggest-a-change-check in the ${scriptName} script`)
  else {
    pkg.scripts[scriptName] = current ? `${current} && suggest-a-change-check` : 'suggest-a-change-check'
    log.did.push(`added suggest-a-change-check to the ${scriptName} script`)
  }
  const next = JSON.stringify(pkg, null, indent) + (raw.endsWith('\n') ? '\n' : '')
  if (next !== raw) writeFileSync(pkgPath, next)

  // 2. The adapters stub: never overwritten.
  if (writeIfAbsent(join(root, 'tailor', 'suggest-a-change.ts'), stubFor(id, owner), log, 'tailor/suggest-a-change.ts'))
    log.notes.push('the adapters in tailor/suggest-a-change.ts are stubs: nobody is signed in and every report is refused, so the button opens nothing until you fill them in. Then delete the "suggest-a-change: STUB" line and use "suggest-a-change-check --strict" in your check script')

  // 4. The component and the root layout.
  const compPath = join(root, dirname(appDir), 'components', 'suggest-a-change.tsx')
  const adaptersImport = dotted(posix(relative(dirname(compPath), join(root, 'tailor', 'suggest-a-change'))))
  writeIfAbsent(compPath, componentFor(adaptersImport), log, posix(relative(root, compPath)))
  const layoutPath = ['tsx', 'jsx', 'js', 'ts'].map((e) => join(root, appDir, `layout.${e}`)).find(existsSync)
  if (!layoutPath) log.notes.push(`no root layout in ${appDir}: render <SuggestChange /> (from ${posix(relative(root, compPath))}) where every screen shows it`)
  else {
    const src = readFileSync(layoutPath, 'utf8')
    if (/\bSuggestChange\b|<SuggestEntry\b/.test(src)) log.kept.push(`entry in ${posix(relative(root, layoutPath))}`)
    else if (childrenSpot(src) < 0) log.notes.push(`${posix(relative(root, layoutPath))} has no JSX {children}: render <SuggestChange /> in it yourself`)
    else {
      const spec = dotted(posix(relative(dirname(layoutPath), compPath)).replace(/\.tsx$/, ''))
      const imports = [...src.matchAll(/^import[^\n]*\n/gm)]
      const at = imports.length ? imports[imports.length - 1].index + imports[imports.length - 1][0].length : 0
      const withImport = src.slice(0, at) + `import { SuggestChange } from '${spec}'\n` + src.slice(at)
      const spot = childrenSpot(withImport)
      if (spot < 0) { log.notes.push(`${posix(relative(root, layoutPath))} renders its children in a way init cannot find: render <SuggestChange /> in it yourself`); return log }
      writeFileSync(layoutPath, withImport.slice(0, spot) + '<SuggestChange />' + withImport.slice(spot))
      log.did.push(`rendered <SuggestChange /> in ${posix(relative(root, layoutPath))}`)
    }
  }
  return log
}

export function runInit(argv, { out = (s) => console.log(s), err = (s) => console.error(s) } = {}) {
  const a = parseArgs(argv, { bool: ['--json'], value: ['--repo', '--app', '--owner'] })
  if (a.help) { out(INIT_USAGE); return 0 }
  if (a.error) { err(`${a.error}\n\n${INIT_USAGE}`); return 2 }
  let log
  try { log = initApp({ repo: a.values['--repo'] ?? process.cwd(), app: a.values['--app'], owner: a.values['--owner'] }) }
  catch (e) { if (e instanceof UsageError) { err(e.message); return 2 } throw e }
  if (a.flags.has('--json')) { out(JSON.stringify(log, null, 2)); return 0 }
  for (const s of log.did) out(s)
  for (const s of log.kept) out(`kept ${s}`)
  for (const s of log.notes) out(`note: ${s}`)
  if (!log.did.length && !log.notes.length) out('already wired; nothing changed')
  return 0
}
