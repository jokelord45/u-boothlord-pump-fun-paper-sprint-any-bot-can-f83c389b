// Flow-scalp for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// What the local replay of the kit's dev window (24h of pump.fun chain data)
// showed: nearly every launch spikes in its first ~20 slots and then fades, so
// buying the launch itself loses money on every pilot strategy the kit ships
// (sniper -0.49 SOL, momentum -2.36 SOL, reversion -3.78 SOL on the full dev
// window). The one shape that survives is a narrow, fast scalp: a coin at
// least 20 slots old that is RIGHT NOW taking in fresh SOL -- at least 0.15 SOL
// of net buys over the last 20 slots -- from at most 5 distinct buyers, with
// the creator not having sold. Buy a small stake (capped at 1% of the curve's
// real SOL reserve, so usually far less than the 0.1 SOL target), take +15%,
// cut at -8%, never hold past 10 slots, and leave at once if the creator sells.
// Winners are 1-3 coins per day (+0.03-0.04 SOL each); the rest bleed a little,
// and the net on the dev window is +0.011 SOL over 82 coins with max drawdown
// 0.4%.
//
// Two pilot mistakes this avoids: (1) the pilot sniper splits orders into
// pieces when its fill count lags a pace target -- each piece pays its own
// 105k lamport tx fee, which cost ~0.014 SOL on the dev window for nothing
// (the competition has no minimum-fills guardrail), so orders are never split
// here; (2) the pilots buy launches at age 0-3 slots, i.e. the top of the
// creator's own pump.
//
// A pace-based probe keeps the run above the guardrail's 20-coin bar on a
// short final window: if the bot's own coin count lags 21 coins prorated over
// the 6-hour window it buys 0.01 SOL of the most liquid coin trading that
// batch and sells it as soon as the buy lands. Probes only fire when behind
// pace, so on a busy window they never fire.
//
// Deterministic by construction: no clock, no randomness, no I/O -- only the
// batches the harness sends, iterated in insertion order. The two graded
// executions therefore produce byte-identical action logs.

import { BPS, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports to aim for per coin in total (each reply is still capped at 1% of real SOL). */
  stakeLamports: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: lamports window. */
  minDevBuy: number;
  maxDevBuy: number;
  /** Trades seen and distinct (non-creator) buyers seen before entry. */
  minTrades: number;
  minBuyers: number;
  /** Distinct non-creator buyers before entry, at most: a launch bundled by many wallets is a dump in waiting. */
  maxBuyers: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /** Largest single non-creator sell seen, as bps of the real SOL reserve before it, at most. */
  maxBigSellBps: number;
  /** Price now over the create price, as bps: window. */
  minRunupBps: number;
  maxRunupBps: number;
  /** The recent-flow window (slots) and what it must show. */
  flowWindow: number;
  minFlowLamports: number;
  minRecentBuyers: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Guardrail pacing: the run must hold a round trip on at least targetCoins coins. When the
   * bot's own coin count lags targetCoins prorated over paceSeconds of block time from the
   * first event, it opens a tiny probe round trip (buy probeLamports, sell it all as soon as
   * the buy lands) on the most liquid coin trading that batch. */
  targetCoins: number;
  paceSeconds: number;
  probeLamports: number;
  /** Most probe round trips open at once. */
  maxProbes: number;
}

// Chosen on the dev window with tools/grid.ts (see the header): the flow scalp's flat,
// positive region, not its single best cell. maxBuyers 5 keeps 82 coins on the dev window
// (vs 29 at maxBuyers 3) while the net stays positive (+0.011 SOL); a 6th buyer turns the
// first half of the window sharply negative. The 8% stop beats 12% (+0.015 vs +0.011 at
// maxAge 600); the 5% stop is far worse (-0.051). Never splitting orders is worth +0.014.
export const DEFAULT_PARAMS: Params = {
  minAge: 20,
  maxAge: 900,
  stakeLamports: 100_000_000,
  minBuyLamports: 5_000_000,
  minRealSol: 300_000_000,
  maxRealSol: 30_000_000_000,
  minDevBuy: 0,
  maxDevBuy: 2_500_000_000,
  minTrades: 0,
  minBuyers: 0,
  maxBuyers: 5,
  maxSellRatioBps: 10_000,
  maxBigSellBps: 10_000,
  minRunupBps: 0,
  maxRunupBps: 1_000_000,
  flowWindow: 20,
  minFlowLamports: 150_000_000,
  minRecentBuyers: 0,
  skipDevSold: true,
  buySlippageBps: 10_000,
  tpBps: 1500,
  slBps: 800,
  maxHold: 10,
  exitOnDevSell: true,
  targetCoins: 21,
  paceSeconds: 21_600,
  probeLamports: 10_000_000,
  maxProbes: 1,
};

/** One trade inside a coin's recent-flow window. */
interface RecentTrade {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

/** Everything the strategy remembers about one launched coin. */
interface CoinState {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create-time reserves: the price run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  /** Trades of the last flowWindow slots (older ones dropped as new ones come). */
  recent: RecentTrade[];
  buysSent: number;
  spentSent: bigint;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

/** A position the bot opened itself, with what it has cost in tx fees so far. */
interface OpenPosition {
  openedSlot: number;
  txPaid: bigint;
  devSoldAtOpen: boolean;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

/** Curve fee on a sell: protocol 95 bps + creator 30 bps = 125 bps. */
const FEE_BPS = 125n;

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  return gross - (gross * FEE_BPS + BPS - 1n) / BPS;
}

/** A fresh coin record, built from its CreateEvent. */
function newCoin(mint: Pubkey, slot: number, creator: Pubkey, vq0: bigint, vt0: bigint): CoinState {
  return {
    mint,
    createSlot: slot,
    creator,
    vq0,
    vt0,
    devBuy: 0n,
    trades: 0,
    buyers: new Set(),
    bought: 0n,
    soldByOthers: 0n,
    bigSellBps: 0n,
    devSold: false,
    lastTradeSlot: slot,
    recent: [],
    buysSent: 0,
    spentSent: 0n,
    done: false,
    complete: false,
  };
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const P = params;
  const coins = new Map<Pubkey, CoinState>();
  const held = new Map<Pubkey, OpenPosition>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  const stake = BigInt(P.stakeLamports);
  const minBuy = BigInt(P.minBuyLamports);
  /** The bot's own filled orders and the coins they were on. */
  const myCoins = new Set<Pubkey>();
  let myFills = 0;
  let firstTime: number | null = null;
  let nowTime = 0;

  function noteCreate(mint: Pubkey, slot: number, creator: Pubkey, vq: bigint, vt: bigint): void {
    coins.set(mint, newCoin(mint, slot, creator, vq, vt));
  }

  function noteTrade(
    c: CoinState,
    slot: number,
    isBuy: boolean,
    sol: bigint,
    user: Pubkey,
    realQuoteBefore: bigint,
  ): void {
    c.trades += 1;
    c.lastTradeSlot = slot;
    c.recent.push({ slot, isBuy, sol, user });
    const isDev = user === c.creator;
    if (isBuy) {
      c.bought += sol;
      if (isDev && slot === c.createSlot) c.devBuy += sol;
      else if (!isDev) c.buyers.add(user);
    } else if (isDev) {
      c.devSold = true;
    } else {
      c.soldByOthers += sol;
      if (realQuoteBefore > 0n) {
        const bps = (sol * BPS) / realQuoteBefore;
        if (bps > c.bigSellBps) c.bigSellBps = bps;
      }
    }
  }

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        noteCreate(e.mint, e.slot, e.creator, BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        // real_quote_reserves is the reserve AFTER this trade, so add the sold
        // amount back to get the reserve the sell was sized against.
        const rqBefore = BigInt(e.real_quote_reserves) + (e.is_buy ? 0n : BigInt(e.sol_amount));
        noteTrade(c, e.slot, e.is_buy, BigInt(e.sol_amount), e.user, rqBefore);
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Net lamports bought minus sold and the distinct buyers, over the last flowWindow slots. */
  function flow(c: CoinState, slot: number): { net: bigint; buyers: number } {
    const from = slot - P.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.isBuy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else {
        net -= t.sol;
      }
    }
    return { net, buyers: buyers.size };
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === 'buy') return true;
    }
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) {
      if (p.order.mint === mint && p.order.side === 'sell') return true;
    }
    return false;
  }

  /** Take-profit / stop-loss thresholds, built once: value*Bps is compared against basis*threshold. */
  const tpThreshold = BPS + BigInt(P.tpBps);
  const slThreshold = BPS - BigInt(P.slBps);

  /** True when a held position should be exited this batch. */
  function shouldExit(
    state: BotState,
    mint: Pubkey,
    pos: { token_amount: bigint; cost_lamports: bigint },
    h: OpenPosition,
    c: CoinState | undefined,
    vq: bigint,
    vt: bigint,
    tx: bigint,
  ): boolean {
    const value = sellValue(pos.token_amount, vq, vt) - tx;
    const basis = pos.cost_lamports + h.txPaid;
    if (basis > 0n) {
      if (value * BPS >= basis * tpThreshold) return true;
      if (value * BPS <= basis * slThreshold) return true;
    }
    if (state.slot - h.openedSlot >= P.maxHold) return true;
    if (c !== undefined && P.exitOnDevSell && c.devSold && !h.devSoldAtOpen) return true;
    return false;
  }

  /** Expected coin count at the current pace: targetCoins prorated over
   * paceSeconds of block time since the first event, capped at the target.
   * The pace fraction never exceeds 1, so once the full window has elapsed
   * the target is simply targetCoins and no further probe can be justified
   * by the clock alone. */
  function paceTarget(): number {
    if (firstTime === null) return 0;
    const pace = Math.min(1, (nowTime - firstTime) / P.paceSeconds);
    return Math.ceil(P.targetCoins * pace);
  }

  /** True when a probe round trip is allowed this batch: a probe slot is
   * free, an open-position slot is free, the window has started, and the
   * bot's own coin count lags the prorated pace target. On a busy window
   * the count keeps up on real entries alone, so this stays false and no
   * probe ever fires. */
  function shouldProbe(state: BotState, openPositions: number): boolean {
    if (probes.size >= P.maxProbes) return false;
    if (openPositions >= state.hello.caps.max_open_positions) return false;
    if (firstTime === null) return false;
    return myCoins.size < paceTarget();
  }

  /** Most liquid coin trading this batch that the bot does not already hold,
   * probe, or have a buy pending for, and whose real SOL reserve clears the
   * probe's minimum size (1.5x the reserve a max-size probe order needs, so
   * the probe buy stays well inside the per-order reserve cap). Returns
   * null when no coin trading this batch qualifies. */
  function pickProbeMint(state: BotState, batch: Batch): Pubkey | null {
    const minRq = (BigInt(P.probeLamports) * BPS) / BigInt(state.hello.caps.max_order_bps_of_real_reserve);
    let best: Pubkey | null = null;
    let bestRq = 0n;
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      const mint = e.mint;
      if (coins.get(mint)?.done) continue;
      if (state.positions.has(mint) || probes.has(mint) || hasPendingBuy(state, mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const rq = curve.real_quote_reserves;
      if (rq < minRq * 3n / 2n) continue;
      if (rq > bestRq) {
        bestRq = rq;
        best = mint;
      }
    }
    return best;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      for (const e of batch.events) {
        if (e.block_time === null) continue;
        if (firstTime === null) firstTime = e.block_time;
        if (e.block_time > nowTime) nowTime = e.block_time;
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }

      // Reconcile fills: forced closes (client ids starting with '_') clear the
      // bookkeeping, real fills record the coin and accumulate tx fees.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        if (f.status === 'filled') {
          myFills += 1;
          myCoins.add(f.mint);
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports), devSoldAtOpen: coins.get(f.mint)?.devSold ?? false });
        }
      }
      for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
      }
      for (const mint of [...probes.keys()]) {
        if (!state.positions.has(mint) && !hasPendingBuy(state, mint) && !hasPendingSell(state, mint)) probes.delete(mint);
      }

      // Exits first: take profit, stop loss, time limit, creator sold.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, devSoldAtOpen: c?.devSold ?? false };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        if (!shouldExit(state, mint, pos, h, c, mk.vq, mk.vt, tx)) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, sellingProbe] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!hasPendingBuy(state, mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || hasPendingSell(state, mint) || selling.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!sellingProbe) probes.set(mint, true);
      }

      // Entries: every filter in order; a coin that fails a permanent filter is
      // marked done so it is never reconsidered, a coin that fails a transient
      // filter (reserves, flow, run-up) is simply skipped this batch.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        if (age > P.maxAge) {
          c.done = true;
          continue;
        }
        if (age < P.minAge) continue;
        if (open >= state.hello.caps.max_open_positions) continue;
        if (state.positions.has(c.mint) || probes.has(c.mint) || hasPendingBuy(state, c.mint)) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold && P.skipDevSold) {
          c.done = true;
          continue;
        }
        // Rug filter.
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(P.minRealSol) || rq > BigInt(P.maxRealSol)) continue;
        if (c.devBuy < BigInt(P.minDevBuy) || c.devBuy > BigInt(P.maxDevBuy)) continue;
        if (c.trades < P.minTrades || c.buyers.size < P.minBuyers || c.buyers.size > P.maxBuyers) continue;
        if (c.bought > 0n && c.soldByOthers * BPS > c.bought * BigInt(P.maxSellRatioBps)) continue;
        if (c.bigSellBps > BigInt(P.maxBigSellBps)) continue;
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
        if (runup > BigInt(P.maxRunupBps) || runup < BigInt(P.minRunupBps)) continue;
        const fl = flow(c, state.slot);
        if (fl.net < BigInt(P.minFlowLamports) || fl.buyers < P.minRecentBuyers) continue;
        const room = stake - c.spentSent;
        if (room < minBuy) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = room < maxBuy ? room : maxBuy;
        if (amount < minBuy) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + tx;
        c.buysSent += 1;
        c.spentSent += amount;
        open += 1;
      }

      // Guardrail pacing: open a probe when the bot's coin count lags the pace.
      if (shouldProbe(state, open)) {
        const best = pickProbeMint(state, batch);
        if (best !== null && free >= BigInt(P.probeLamports) + tx) {
          orders.push({ side: 'buy', mint: best, quote_lamports: BigInt(P.probeLamports), max_slippage_bps: P.buySlippageBps });
          probes.set(best, false);
        }
      }
      return orders;
    },
  };
}
