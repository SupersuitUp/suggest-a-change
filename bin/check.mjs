#!/usr/bin/env node
// suggest-a-change-check: exit 0 clean, 1 problems, 2 usage.
import { runCheck } from '../src/check/cli.mjs'
process.exit(runCheck(process.argv.slice(2)))
