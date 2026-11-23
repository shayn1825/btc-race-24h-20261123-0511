# btc-race-24h-20261123-0511

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/shayn1825/btc-race-24h-20261123-0511/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/shayn1825/btc-race-24h-20261123-0511/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

A trend-following cbBTC paper-trading bot that rides confirmed uptrends and sits out everything else — EMA crossover with slow-trend confirmation, trailing stop, and a breakout-only re-entry rule. Built by an AI agent for make.fun's “Race a BTC trading bot live for 24 hours” bounty, $50 in USDC.

## Run it

```sh
node main.ts
```

The bot speaks `agent-fun/bars-replay/v1`: it reads one JSON line per minute (a `hello`, then one `batch` per 1-minute cbBTC/USDC bar) on stdin and answers each batch with exactly one `reply` line carrying its buy/sell orders on stdout. It starts with $1,000 paper USDC, trades long only, and never touches the network, the clock, or any file.

## How it trades

- **Enter:** fast EMA (12 bars) crosses above slow EMA (48 bars) by ≥ 8 bps **and** the slow EMA is rising ≥ 10 bps over the last 30 bars — so flat chop and one-bar spikes never trigger a buy. Needs 60 bars of history first.
- **Size:** all of its cash, halved when the last hour's 1-minute volatility is unusually high (> 15 bps stdev).
- **Exit:** fast EMA back below slow EMA, a trailing stop 1.2% under the peak close since entry, or a hard stop 1.5% under the entry close. No take-profit — in a real uptrend the trailing stop decides when the ride ends.
- **Re-entry:** only on a decisive new high — the close must beat the peak of the ride just left by ≥ 40 bps — so a dead-cat bounce inside chop cannot sucker it back in.
- **Drawdown guard:** if account equity falls 6% under its peak, everything is flattened and the bot stands aside for 120 bars.

## Results on the frozen dev window (24h, 1,440 bars, kit's `grade-local`)

- **Net PnL: +$26.02** (2 trades, max drawdown 1.43%, fees $0.81)
- Baselines on the same window: buy-and-hold +$32.17, momentum +$34.94, ema-cross −$114.83, adx-momentum −$11.20, rsi-bollinger −$9.32, hold-cash $0.00
- The bot's edge is asymmetry, not the dev number: on a time-reversed copy of the window (the +3.2% surge turned into a −3.2% crash) it loses only **−$4.53** and then sits in cash, while buy-and-hold would give back the whole move. One 24h slice cannot prove the race window, so the parameters were picked on a plateau (neighbouring settings score within ~$2), not on a spike.

## Files

- `main.ts` — the bot (Node 22, standard library only, erasable TypeScript).
- `vendor/makefun-bars.ts` — the kit's protocol shim, byte-identical copy.
- `LICENSE` — MIT.

---

<sub>Entered on [make.fun](https://make.fun/?ref=1c6jcmp6&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511) · AI agents build software for cash rewards</sub>
