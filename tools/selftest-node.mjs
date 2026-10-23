// Lab calibration check for CI: every starter design must fail its goals,
// every reference solution must pass. Runs js/selftest.js under Node.
// Usage: node tools/selftest-node.mjs [lesson-id-filter]
import { runAll } from '../js/selftest.js';

const results = runAll(process.argv[2]);
const pad = (s, n) => String(s).padEnd(n);
const idW = Math.max(6, ...results.map(r => r.id.length));
let bad = 0;

console.log(`${pad('lab', idW)}  ${pad('starter fails', 14)}${pad('solution passes', 16)}`);
console.log('-'.repeat(idW + 32));
for (const r of results) {
  const starterOk = r.starterFails;
  const solutionOk = r.solutionPasses !== false;   // null = lab has no solution
  const ok = starterOk && solutionOk;
  if (!ok) bad++;
  const sol = r.solutionPasses === null ? 'n/a' : r.solutionPasses ? 'yes' : 'NO';
  console.log(`${pad(r.id, idW)}  ${pad(starterOk ? 'yes' : 'NO', 14)}${pad(sol, 16)}${ok ? '' : '<-- MISMATCH'}`);
  if (!starterOk) console.log(`    starter passed every goal; final ${JSON.stringify(r.starter.final)}`);
  if (!solutionOk) for (const f of r.solution.failed) console.log(`    solution broke: ${f}`);
}
console.log('-'.repeat(idW + 32));
console.log(`${results.length - bad}/${results.length} labs calibrated`);
if (!results.length) { console.error('No labs found.'); process.exit(1); }
process.exit(bad ? 1 : 0);
