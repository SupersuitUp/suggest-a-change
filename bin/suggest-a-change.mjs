#!/usr/bin/env node
// suggest-a-change: the module's command line. Exit codes: 0 ok, 1 problems, 2 usage.
//   suggest-a-change init [...]    wire an app to Suggest a change
//   suggest-a-change check [...]   the screen check (also installed as suggest-a-change-check)
import { runCheck } from '../src/check/cli.mjs'
import { runInit } from '../src/check/init.mjs'

const USAGE = `suggest-a-change: the report format and flow behind a Suggest a change button.

Usage:
  suggest-a-change init  [--repo <path>] [--app <id>] [--owner <name>] [--json]
  suggest-a-change check [--repo <path>] [--config <file>] [--app-dir <dir>] [--adapters <file>] [--json]
  suggest-a-change --help

"check" is the same command as suggest-a-change-check. Run either with --help for its flags.
The report contract is a library: import it from "@supersuit/suggest-a-change".`

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === '--help' || cmd === '-h') { console.log(USAGE); process.exit(0) }
if (cmd === 'init') process.exit(runInit(rest))
if (cmd === 'check') process.exit(runCheck(rest))
console.error(cmd ? `unknown command ${cmd}\n\n${USAGE}` : USAGE)
process.exit(2)
