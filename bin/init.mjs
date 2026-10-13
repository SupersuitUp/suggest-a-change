#!/usr/bin/env node
// suggest-a-change init: exit 0 done, 2 usage.
import { runInit } from '../src/check/init.mjs'
process.exit(runInit(process.argv.slice(2)))
