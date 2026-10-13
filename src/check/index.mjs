// THE SCREEN CHECK. Proves that every screen below an app's home carries the Suggest a change entry, and that
// the app supplies the four adapters. Static, zero dependencies, and it never imports react or the client:
// it reads source text. Exported as "@supersuit/suggest-a-change/check"; the command is suggest-a-change-check.
//
//   checkSuggestEverywhere({ repo, appDir, config, adaptersFile })  Next.js app router, by reading source
//   checkEntryOnRoutes({ routes, render })                          one-shell apps (a Vite app), by rendering
//
// WHAT IT CAN SEE. A screen passes when its page, or any layout from the app directory down to the page's own
// folder, renders `<SuggestEntry` or carries `data-suggest-entry`, either directly or through a component those
// files import (local and "@/" imports, followed DEPTH levels deep). WHAT IT CANNOT SEE: whether the entry is
// rendered conditionally, a component reached by a re-export chain deeper than DEPTH, an import through a path
// alias other than "@/" and "~/", or an entry added by code that builds elements from a string. It reads text,
// not a running app.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname, relative, sep, isAbsolute } from 'node:path'

export const ADAPTERS = ['identity', 'store', 'words', 'limits']
export const DEPTH = 3
const PAGE = /^page\.(tsx|ts|jsx|js|mdx)$/
const LAYOUT = /^(layout|template)\.(tsx|ts|jsx|js)$/
const CODE_EXTS = ['.tsx', '.ts', '.jsx', '.js', '.mjs']
const SKIP_DIR = new Set(['node_modules', '.next', '__fixtures__'])

/** A problem with how the check was called or what it was pointed at (exit 2), not a problem with the app. */
export class UsageError extends Error {}

// A small scanner that knows where JavaScript has strings and comments and where JSX has text. Strings only
// exist in code and in attribute values; JSX text is text (an apostrophe in it starts nothing). It returns:
//   plain     the source with comments blanked (strings and JSX text kept), for reading imports and exports
//   code      the source with comments, strings and JSX text blanked
//   elements  every JSX element name, e.g. "SuggestEntry" or "ui.Shell"
//   attrs     every JSX attribute name, e.g. "data-suggest-entry"
// It is not a parser: it decides "is this < the start of JSX" from the token before it, and a regular
// expression literal holding a quote can confuse it. Nothing it finds inside a string literal counts.
const JSX_AFTER = new Set(['return', 'yield', 'await', 'case', 'default', 'else', 'in', 'of', 'do', 'void', 'typeof', 'delete', 'throw'])
const blankOf = (t) => t.replace(/[^\n]/g, ' ')

export function scan(src) {
  const n = src.length
  let i = 0, plain = '', code = ''
  const elements = new Set(), attrs = new Set()
  const emit = (raw, c = raw) => { plain += raw; code += c }
  const emitBlank = (raw) => emit(raw, blankOf(raw))
  const stringEnd = (q) => { let j = i + 1; while (j < n && src[j] !== q && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1; return Math.min(j + 1, n) }
  const skipString = () => { const q = src[i], j = stringEnd(q); const t = src.slice(i, j); emit(t, q + blankOf(t.slice(1, -1)) + (t.length > 1 ? q : '')); i = j }
  const comment = () => {
    if (src[i] === '/' && src[i + 1] === '/') { let j = src.indexOf('\n', i); if (j < 0) j = n; emitBlank(src.slice(i, j)); i = j; return true }
    if (src[i] === '/' && src[i + 1] === '*') { let j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; emitBlank(src.slice(i, j)); i = j; return true }
    return false
  }
  const jsxStart = () => {
    if (!/[A-Za-z_$>]/.test(src[i + 1] ?? '')) return false
    let k = code.length - 1
    while (k >= 0 && /\s/.test(code[k])) k--
    if (k < 0) return true
    if (/[\w$]/.test(code[k])) { let e = k; while (e >= 0 && /[\w$]/.test(code[e])) e--; return JSX_AFTER.has(code.slice(e + 1, k + 1)) }
    return code[k] !== ')' && code[k] !== ']'
  }
  function scanCode(inBraces) {
    while (i < n) {
      const c = src[i]
      if (comment()) continue
      if (c === '"' || c === "'") { skipString(); continue }
      if (c === '`') {
        emit('`'); i++
        while (i < n && src[i] !== '`') {
          if (src[i] === '\\') { emitBlank(src.slice(i, i + 2)); i += 2 }
          else if (src[i] === '$' && src[i + 1] === '{') { emit('${'); i += 2; scanCode(true) }
          else { emitBlank(src[i]); i++ }
        }
        if (i < n) { emit('`'); i++ }
        continue
      }
      if (c === '{') { emit('{'); i++; scanCode(true); continue }
      if (c === '}') { emit('}'); i++; if (inBraces) return; continue }
      if (c === '<' && jsxStart()) { element(); continue }
      emit(c); i++
    }
  }
  function tagSpace() {
    for (;;) {
      if (/\s/.test(src[i] ?? '')) { emitBlank(src[i]); i++; continue }
      if (!comment()) return
    }
  }
  function element() {
    emitBlank('<'); i++
    if (src[i] === '>') { emitBlank('>'); i++; children(); return }
    const m = /^[A-Za-z_$][\w$.:-]*/.exec(src.slice(i, i + 200))
    if (!m) return
    elements.add(m[0]); emitBlank(m[0]); i += m[0].length
    for (;;) {
      tagSpace()
      if (i >= n) return
      const c = src[i]
      if (c === '/' && src[i + 1] === '>') { emitBlank('/>'); i += 2; return }
      if (c === '>') { emitBlank('>'); i++; children(); return }
      if (c === '{') { emit('{'); i++; scanCode(true); continue }
      const a = /^[\w$:.-]+/.exec(src.slice(i, i + 200))
      if (!a) { emitBlank(c); i++; continue }
      attrs.add(a[0]); emitBlank(a[0]); i += a[0].length
      tagSpace()
      if (src[i] !== '=') continue
      emitBlank('='); i++
      tagSpace()
      if (src[i] === '"' || src[i] === "'") skipString()
      else if (src[i] === '{') { emit('{'); i++; scanCode(true) }
      else if (src[i] === '<') element()
    }
  }
  function children() {
    for (;;) {
      let j = i
      while (j < n && src[j] !== '<' && src[j] !== '{') j++
      if (j > i) { emitBlank(src.slice(i, j)); i = j }
      if (i >= n) return
      if (src[i] === '{') { emit('{'); i++; scanCode(true); continue }
      if (src[i + 1] === '/') { let e = src.indexOf('>', i); e = e < 0 ? n : e + 1; emitBlank(src.slice(i, e)); i = e; return }
      if (/[A-Za-z_$>]/.test(src[i + 1] ?? '')) element()
      else { emitBlank('<'); i++ }
    }
  }
  scanCode(false)
  return { plain, code, elements, attrs }
}

/** The source with comments blanked (strings and JSX text kept). */
export const stripComments = (src) => scan(src).plain

const esc = (t) => t.replace(/[$.*+?^{}()|[\]\\]/g, '\\$&')
const lastSeg = (name) => name.split('.').pop()

function rendersDirectly(s) {
  return [...s.elements].some((e) => lastSeg(e) === 'SuggestEntry') || s.attrs.has('data-suggest-entry') ||
    /\bcreateElement\(\s*(?:[\w$]+\.)?SuggestEntry\b|\bjsxs?\(\s*(?:[\w$]+\.)?SuggestEntry\b/.test(s.code)
}

// A name is "used" when the file renders it as an element (or hands it to createElement / jsx).
function used(s, name) {
  for (const e of s.elements) if (e === name || e.startsWith(name + '.')) return true
  return new RegExp(`\\b(?:createElement|jsxs?)\\(\\s*${esc(name)}\\b`).test(s.code)
}

// The local files a file hands components to: each import with the names it binds (followed only when one of
// them is rendered), and re-exports (followed always: a barrel file renders nothing itself).
function hopsOf(plain) {
  const hops = []
  for (const m of plain.matchAll(/\bimport\s+(?!\()(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    if (m[1]) continue
    const clause = m[2], names = []
    const def = /^([A-Za-z_$][\w$]*)/.exec(clause)
    if (def) names.push(def[1])
    const named = /\{([^}]*)\}/.exec(clause)
    if (named) for (const part of named[1].split(',')) { const t = part.trim(); if (!t || /^type\s/.test(t)) continue; const as = t.split(/\s+as\s+/); names.push((as[1] ?? as[0]).trim()) }
    const ns = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause)
    if (ns) names.push(ns[1])
    hops.push({ spec: m[3], names })
  }
  for (const m of plain.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[\w$]+\.)?(?:dynamic|lazy)\(\s*\(\s*\)\s*=>\s*import\(\s*['"]([^'"]+)['"]/g)) hops.push({ spec: m[2], names: [m[1]] })
  for (const m of plain.matchAll(/\bexport\s*(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g)) hops.push({ spec: m[1], names: null })
  return hops
}

const scanned = new Map()
function scanFile(file) {
  const text = readFileSync(file, 'utf8')
  const hit = scanned.get(file)
  if (hit && hit.text === text) return hit.s
  const s = scan(text)
  scanned.set(file, { text, s })
  return s
}

// A file "renders the entry" when it does itself, or when it renders a component it imports (the binding
// must appear as an element in the importing file) that does, to DEPTH hops. Which component inside an
// imported file renders the entry is not checked.
function rendersEntry(file, aliases, depth, seen = new Set()) {
  if (seen.has(file)) return false
  seen.add(file)
  const s = scanFile(file)
  if (rendersDirectly(s)) return true
  if (depth <= 0) return false
  for (const hop of hopsOf(s.plain)) {
    if (hop.names && !hop.names.some((b) => used(s, b))) continue
    const target = resolveImport(file, hop.spec, aliases)
    if (target && rendersEntry(target, aliases, depth - 1, seen)) return true
  }
  return false
}

function walk(dir, keep) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return SKIP_DIR.has(n) ? [] : walk(p, keep)
    return keep(n, p) ? [p] : []
  })
}

// The URL a page file serves: its folder path under the app directory, with route groups `(name)` and parallel
// slots `@name` removed. The same rule the home-screen check uses, so both read one screen list.
export function routeOf(appDir, file) {
  const segs = relative(appDir, dirname(file)).split(sep).filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@'))
  return '/' + segs.join('/')
}

function resolveImport(from, spec, aliases) {
  let base = null
  if (spec.startsWith('.')) base = resolve(dirname(from), spec)
  else for (const [alias, dir] of Object.entries(aliases)) if (spec.startsWith(alias)) { base = join(dir, spec.slice(alias.length)); break }
  if (!base) return null
  const tries = [base, ...CODE_EXTS.map((e) => base + e), ...CODE_EXTS.map((e) => join(base, 'index' + e))]
  return tries.find((p) => existsSync(p) && statSync(p).isFile()) ?? null
}

/** The names a file exports, following `export * from` and `export { x } from` into local files. */
export function exportsOf(file, aliases = {}, depth = DEPTH, seen = new Set()) {
  const names = new Set()
  if (seen.has(file) || !existsSync(file)) return names
  seen.add(file)
  const code = stripComments(readFileSync(file, 'utf8'))
  for (const m of code.matchAll(/\bexport\s+(?:declare\s+)?(?:const|let|var|function\*?|async\s+function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  for (const m of code.matchAll(/\bexport\s*(type\s*)?\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/g)) {
    if (m[1]) continue
    for (const part of m[2].split(',')) {
      const p = part.trim()
      if (!p || /^type\s/.test(p)) continue
      const as = p.split(/\s+as\s+/)
      names.add((as[1] ?? as[0]).trim())
    }
  }
  if (depth > 0) {
    for (const m of code.matchAll(/\bexport\s*\*\s*from\s*['"]([^'"]+)['"]/g)) {
      const t = resolveImport(file, m[1], aliases)
      if (t) for (const n of exportsOf(t, aliases, depth - 1, seen)) names.add(n)
    }
  }
  return names
}

function readConfig(repo, config) {
  const p = resolve(repo, config)
  if (!existsSync(p)) return {}
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch (e) { throw new UsageError(`${config}: not readable JSON (${e.message})`) }
}

export function adapterFileFor(repo, config = {}) {
  const named = config['suggest-a-change']?.adapters
  if (named) return named
  return ['tailor/suggest-a-change.ts', 'tailor/suggest-a-change.tsx', 'tailor/suggest-a-change.mjs', 'tailor/suggest-a-change.js']
    .find((f) => existsSync(join(repo, f))) ?? 'tailor/suggest-a-change.ts'
}

export function appDirFor(repo, config = {}) {
  return config.appDir ?? (existsSync(join(repo, 'src/app')) ? 'src/app' : existsSync(join(repo, 'app')) ? 'app' : 'src/app')
}

/** The full result: { problems, warnings, checked, exempted, adapters }. `strict` turns the stub warning into a problem. */
export const STUB_SENTINEL = 'suggest-a-change: STUB'
const inside = (root, p) => { const r = relative(root, p); return r === '' || (!r.startsWith('..') && !isAbsolute(r)) }

export function inspectSuggestEverywhere({ repo, appDir, config = 'home-screen.json', adaptersFile, depth = DEPTH, strict = false }) {
  if (!repo) throw new UsageError('repo is required')
  const root = resolve(repo)
  if (!existsSync(root)) throw new UsageError(`${root}: no such folder`)
  const cfg = readConfig(root, config)
  const app = resolve(root, appDir ?? appDirFor(root, cfg))
  if (!inside(root, app)) throw new UsageError(`${appDir ?? cfg.appDir}: the app directory is outside ${root}, so it was not read`)
  if (!existsSync(app)) throw new UsageError(`${relative(root, app) || app}: no app directory here, so there is no Next app to check (pass --app-dir)`)
  const rel = (p) => relative(root, p).split(sep).join('/')
  const src = existsSync(join(root, 'src')) ? join(root, 'src') : root
  const aliases = { '@/': src + sep, '~/': src + sep }
  const home = cfg.home ?? ['/']
  const exempt = cfg['suggest-a-change']?.exempt ?? {}
  const problems = [], warnings = [], checked = [], exempted = []
  const pages = walk(app, (n, p) => PAGE.test(n) && !relative(app, p).split(sep).some((s) => s.startsWith('_')))
  if (!pages.length) throw new UsageError(`${rel(app)}: no pages (page.tsx, page.jsx, page.js, page.ts or page.mdx) were found under it, so nothing was checked`)

  // 1. The adapters: all four exported.
  const adapters = adaptersFile ?? adapterFileFor(root, cfg)
  const adaptersPath = resolve(root, adapters)
  if (!inside(root, adaptersPath)) throw new UsageError(`${adapters}: the adapters file is outside ${root}, so it was not read`)
  if (!existsSync(adaptersPath)) {
    problems.push(`${adapters}: the adapters file is missing, so the app supplies none of identity, store, words and limits. Run "suggest-a-change init"`)
  } else {
    const have = exportsOf(adaptersPath, aliases, depth)
    for (const name of ADAPTERS) if (!have.has(name)) problems.push(`${adapters}: the adapter "${name}" is not exported. The file must export all of ${ADAPTERS.join(', ')}`)
    if (readFileSync(adaptersPath, 'utf8').includes(STUB_SENTINEL)) {
      const msg = `${adapters}: still the stub "suggest-a-change init" wrote (it carries the "${STUB_SENTINEL}" line): nobody is signed in and every report is refused, so the button opens nothing. Fill in the four adapters, then delete that line`
      if (strict) problems.push(msg)
      else warnings.push(msg)
    }
  }

  // 2. Every screen below home is under a layout (or is itself) rendering the entry, or is exempt with a reason.
  const routes = new Set()
  const layoutCache = new Map()
  const layoutRenders = (file) => { if (!layoutCache.has(file)) layoutCache.set(file, rendersEntry(file, aliases, depth)); return layoutCache.get(file) }
  for (const file of pages) {
    const route = routeOf(app, file)
    routes.add(route)
    if (home.includes(route)) continue
    checked.push(route)
    if (route in exempt) {
      const why = String(exempt[route] ?? '').trim()
      if (why) exempted.push([route, why])
      else problems.push(`${rel(file)}: the screen ${route} is exempt from Suggest a change with no reason written down`)
      continue
    }
    // Every layout from the app directory down to this page's own folder applies to it, route groups included.
    const chain = []
    const parts = relative(app, dirname(file)).split(sep).filter(Boolean)
    for (let i = 0; i <= parts.length; i++) {
      const dir = join(app, ...parts.slice(0, i))
      for (const n of readdirSync(dir)) if (LAYOUT.test(n)) chain.push(join(dir, n))
    }
    if (chain.some(layoutRenders) || rendersEntry(file, aliases, depth)) continue
    problems.push(`${rel(file)}: the screen ${route} has no Suggest a change entry: neither the page nor any layout above it renders <SuggestEntry>. Render it in a layout, or exempt the route under "suggest-a-change.exempt" in ${config} with the reason`)
  }
  for (const r of Object.keys(exempt)) if (!routes.has(r)) problems.push(`${config}: ${r} is exempt from Suggest a change, but there is no screen at ${r}`)
  return { problems, warnings, checked, exempted, adapters }
}

/** Next.js app router, by reading source. Returns the problems; empty means clean. Throws UsageError when it
 *  cannot run (no app directory, unreadable config). */
export function checkSuggestEverywhere(opts) {
  return inspectSuggestEverywhere(opts).problems
}

function routeList(routes) {
  const out = []
  for (const r of routes) out.push(typeof r === 'string' ? { route: r } : { route: r.route ?? r.path, exempt: r.exempt })
  return out
}

function entryProblem(route, html) {
  return typeof html === 'string' && /\bdata-suggest-entry\b/.test(html)
    ? null
    : `route ${route}: renders without the Suggest a change entry (an element carrying data-suggest-entry)`
}

/** An app with one shell: renders every route and looks for `data-suggest-entry`. `render(route)` returns the
 *  route's HTML as a string. A route listed as `{ route, exempt: "reason" }` needs a non-empty reason. */
export function checkEntryOnRoutes({ routes, render }) {
  const list = routeList(routes ?? [])
  if (!list.length) return ['no routes were given, so nothing was checked']
  const problems = []
  for (const { route, exempt } of list) {
    if (exempt !== undefined) { if (!String(exempt).trim()) problems.push(`route ${route}: exempt from Suggest a change with no reason written down`); continue }
    let html
    try { html = render(route) } catch (e) { problems.push(`route ${route}: could not be rendered (${e?.message ?? e})`); continue }
    const p = entryProblem(route, html)
    if (p) problems.push(p)
  }
  return problems
}

/** The same, for a `render` that returns a promise. */
export async function checkEntryOnRoutesAsync({ routes, render }) {
  const list = routeList(routes ?? [])
  if (!list.length) return ['no routes were given, so nothing was checked']
  const problems = []
  for (const { route, exempt } of list) {
    if (exempt !== undefined) { if (!String(exempt).trim()) problems.push(`route ${route}: exempt from Suggest a change with no reason written down`); continue }
    let html
    try { html = await render(route) } catch (e) { problems.push(`route ${route}: could not be rendered (${e?.message ?? e})`); continue }
    const p = entryProblem(route, html)
    if (p) problems.push(p)
  }
  return problems
}
