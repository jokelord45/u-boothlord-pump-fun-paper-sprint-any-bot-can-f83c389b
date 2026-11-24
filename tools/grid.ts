// Parameter sweep over tools/sim.ts: every combination of the given values, ranked by net PnL with
// both window halves shown (a setting that wins only in one half is a fluke, not an edge).
//
//   node tools/grid.ts '{"tpBps":[1000,2000],"slBps":[1000,1500]}' [--base '{"maxAge":10}'] [--top 20]
//
// The first positional argument is the grid (parameter name -> list of values);
// --base overrides DEFAULT_PARAMS for every cell, --exclude drops named mint
// prefixes from the ranking so one lucky coin cannot carry a setting, and
// --top limits how many of the best rows are printed.

import { simulate } from './sim.ts';
import { DEFAULT_PARAMS, type Params } from '../strategy.ts';

const args = process.argv.slice(2);
const get = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const kit = get('--kit') ?? '/Users/toor/.agentfun/pilot/kit-dev/pilot-pumpfun-replay-kit';
const grid: Record<string, unknown[]> = JSON.parse(args[0] ?? '{}');
const base: Params = { ...DEFAULT_PARAMS, ...JSON.parse(get('--base') ?? '{}') };
const top = Number(get('--top') ?? '25');
/** Mint prefixes left out of the ranking (to see what a setting earns without its single best coin). */
const exclude = (get('--exclude') ?? '').split(',').filter((x) => x.length > 0);

interface GridRow {
  label: string;
  best: number;
  net: number;
  h0: number;
  h1: number;
  fills: number;
  mints: number;
  dd: number;
}

/** Expand the grid into the full list of parameter combinations (cartesian product). */
function expandGrid(grid: Record<string, unknown[]>): Record<string, unknown>[] {
  let combos: Record<string, unknown>[] = [{}];
  for (const [k, vs] of Object.entries(grid)) {
    combos = combos.flatMap((c) => vs.map((v) => ({ ...c, [k]: v })));
  }
  return combos;
}

const combos = expandGrid(grid);
const rows: GridRow[] = [];
for (const c of combos) {
  const r = simulate(kit, { ...base, ...c } as Params);
  // Net excluding the named mint prefixes, so the ranking is not one-coin luck.
  let ex = 0n;
  for (const [m, v] of r.perMint) if (exclude.some((p) => m.startsWith(p))) ex += v;
  let best = 0n;
  for (const v of r.perMint.values()) if (v > best) best = v;
  rows.push({
    label: JSON.stringify(c),
    best: Number(best) / 1e9,
    net: Number(r.net - ex) / 1e9,
    h0: Number(r.halves[0]) / 1e9,
    h1: Number(r.halves[1]) / 1e9,
    fills: r.fills,
    mints: r.mints,
    dd: r.maxDD,
  });
}
/** One ranking line: net first, then the best single coin, the two halves, fills/mints and drawdown. */
function formatRow(r: GridRow): string {
  return `${r.net.toFixed(4).padStart(8)} best ${r.best.toFixed(3)} [${r.h0.toFixed(3)} ${r.h1.toFixed(3)}]  fills ${String(r.fills).padStart(4)} mints ${String(r.mints).padStart(3)} dd ${r.dd.toFixed(3)}  ${r.label}`;
}

rows.sort((a, b) => b.net - a.net);
for (const r of rows.slice(0, top)) {
  console.log(formatRow(r));
}
console.log(`${combos.length} combos`);
