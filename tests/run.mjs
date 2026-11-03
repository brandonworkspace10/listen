// Runs Listen's automated tests: the load test and the proxy tests, plus the Safari test with --safari.
// Run from anywhere: node tests/run.mjs  or  node tests/run.mjs --safari
// The manual checks before a release are in tests/SAFARI_SMOKE_TEST.md.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tests = ["load.test.mjs", "proxy.test.mjs"];
if (process.argv.includes("--safari")) tests.push("safari.test.mjs");

const failed = [];
for (const test of tests) {
    console.log(`\n== ${test}`);
    const run = spawnSync(process.execPath, [path.join(here, test)], { stdio: "inherit" });
    if (run.status !== 0) failed.push(test);
}

console.log(failed.length ? `\nFAILED: ${failed.join(", ")}` : `\nAll ${tests.length} test files passed.`);
process.exitCode = failed.length ? 1 : 0;
