#!/usr/bin/env node
// suggest-a-change: the module's command line. Exit codes: 0 ok, 1 refused, 2 usage.
// Only --help exists so far; the screen check (suggest-a-change-check) lands with the "./check" export.
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`suggest-a-change: the report format and flow behind a Suggest a change button.

Usage: suggest-a-change --help

The report contract is a library: import it from "@supersuit/suggest-a-change".
The check command for an app's screens is coming with the "./check" export.`);
  process.exit(0);
}
console.error("usage: suggest-a-change --help");
process.exit(2);
