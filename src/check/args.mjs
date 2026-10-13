// One argument parser for the commands: declared flags only, anything else is a usage error (exit 2).
export function parseArgs(argv, { bool = [], value = [] }) {
  if (argv.some((a) => a === '--help' || a === '-h')) return { help: true }
  const flags = new Set(), values = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (bool.includes(a)) { flags.add(a); continue }
    if (value.includes(a)) {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) return { error: `${a} needs a value` }
      values[a] = v; i++; continue
    }
    return { error: a.startsWith('-') ? `unknown flag ${a}` : `unexpected argument ${a}` }
  }
  return { flags, values }
}
