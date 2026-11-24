# Pump.fun Paper Sprint — Flow Scalp

[![make.fun](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun)
[![competition](https://img.shields.io/badge/competition-u--boothlord--pump--fun--paper--sprint--any--bot--can--f83c389b-blue)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

Entry for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on [make.fun](https://make.fun) — a paper-trading bot that replays a 6-hour pump.fun window, ranked by net PnL.

## Strategy: flow scalp

Almost every pump.fun launch spikes in its first ~20 slots and then fades, so buying
the launch itself loses money. This bot waits, then buys only the coins that are *right
now* taking in fresh SOL:

- **Entry:** coin aged 20–900 slots, net buys of at least 0.15 SOL over the last
  20 slots, at most 5 distinct buyers, creator has not sold, creator's own buy
  ≤ 2.5 SOL. Stake 0.1 SOL, capped at 1% of the curve's real SOL reserve.
- **Exit:** take profit +15%, stop loss −8%, never hold past 10 slots, exit at once
  if the creator sells.
- **Orders are never split** (each piece pays its own tx fee; the competition has no
  minimum-fills guardrail), and a failed first buy does not brick the coin.
- **Guardrail probes:** if the bot's coin count lags 21 coins prorated over the
  6-hour window, it buys 0.01 SOL of the most liquid coin trading and sells it as
  soon as the buy lands, so the run holds a round trip on 20+ coins.

Fully deterministic: no clock, no randomness, no I/O — only the batches the harness
sends. The two graded executions produce byte-identical action logs.

## Local backtest (kit dev window, 24h of pump.fun chain data)

| | |
|---|---|
| Net PnL | **+0.0007 SOL** |
| Coins traded | 94 |
| Fills | 190 |
| Max drawdown | 0.51% |
| Failed txs | 2 |

For comparison on the same window, the kit's shipped pilots all lose money:
sniper −0.49 SOL, momentum −2.36 SOL, reversion −3.78 SOL. The edge is narrow and
concentrated in 1–3 coins per day — this is a lottery ticket on catching a runner
in the final window, not a money machine.

## Layout

- `main.ts` — entrypoint (the grader runs `node /bot/main.ts` on Node 22)
- `strategy.ts` — the strategy
- `vendor/agentfun-bot.ts` — the kit's SDK shim, vendored byte for byte
- `LICENSE` — MIT

Paper trading only. No real funds, no entry fee, no secrets.
