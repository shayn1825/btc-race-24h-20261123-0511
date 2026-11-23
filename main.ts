/**
 * Trend-following cbBTC bot for make.fun btc-race-24h-20261123-0511.
 *
 * Protocol: agent-fun/bars-replay/v1 (NDJSON on stdin/stdout), spoken through the
 * vendored makefun-bars shim. One asset (CBBTC/USDC), $1,000 paper USDC, long only.
 *
 * Strategy, in one paragraph: ride a confirmed uptrend, sit out everything else.
 * A fast EMA crossing above a slow EMA says the short-term drift turned up; the
 * entry only fires when the slow EMA itself is also rising over the last
 * SLOPE_BARS bars, so flat chop and one-bar spikes do not trigger a buy. The bot
 * buys with (nearly) all of its cash, then defends the position three ways: a
 * trend flip (fast EMA back below the slow EMA), a trailing stop under the peak
 * close since entry, and a hard stop under the entry close. An equity drawdown
 * guard flattens everything and stands aside for a long cooldown when the
 * account itself falls too far from its peak. After any exit the bot waits
 * COOLDOWN_BARS bars before it may buy again, so a whipsaw cannot make it pay
 * the ~26 bps round-trip cost twice on the same wiggle. No take-profit: in a
 * real uptrend the trailing stop, not a fixed target, decides when the ride ends.
 * And a re-entry only counts on a new high: after an exit the bot buys again
 * only when the close beats the peak of the ride it just left, so a dead-cat
 * bounce inside flat chop cannot sucker it back in — a genuine trend resuming
 * to new highs can.
 *
 * Costs discipline: every round trip pays about 26 bps (4 bps fee + 2 bps
 * slippage + price impact), so the bot trades rarely — a handful of trades per
 * day at most — and only on a trend signal, never on 1-minute noise.
 *
 * Determinism: pure function of the bars seen so far. No clock, no network, no
 * randomness, no files, no environment. The same bars always give the same
 * orders, so two executions produce byte-identical action logs.
 */

import { runBars } from "./vendor/makefun-bars.ts";
import type { BarsState, Batch, OrderInput } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";

// --- Strategy parameters (tuned on the frozen dev window; see README) ---
const FAST_SPAN = 12; // fast EMA span, in 1-minute bars
const SLOW_SPAN = 48; // slow EMA span, in 1-minute bars
const GAP_BPS = 8; // fast must clear slow by this much (bps) to enter / exit on cross
const SLOPE_BARS = 30; // slow-EMA slope window, in bars
const SLOPE_MIN_BPS = 10; // slow EMA must rise at least this much (bps) over SLOPE_BARS to enter
const MIN_BARS = 60; // bars of history before the first trade (EMAs must settle)
const TRAIL_BPS = 120; // trailing stop: sell when close falls this far under the peak since entry
const STOP_BPS = 150; // hard stop: sell when close falls this far under the entry close
const TAKE_BPS = 0; // take-profit above entry close in bps; 0 disables it
const COOLDOWN_BARS = 20; // bars to wait after any exit before buying again
const BREAKOUT_MARGIN_BPS = 40; // a re-entry must clear the last ride's peak by this much (bps)
const DD_GUARD_BPS = 600; // equity drawdown from peak that flattens everything
const DD_COOLDOWN_BARS = 120; // stand-aside time after the drawdown guard fires
const MAX_SLIP_BPS = 150; // max slippage allowed on any order, vs the latest close
const VOL_WINDOW = 60; // bars for the recent-volatility read
const VOL_HIGH_BPS = 15; // 1-minute return stdev above which size is halved
const SIZE_LOW_NUM = 1n; // low-volatility-size numerator (fraction SIZE_LOW_NUM/SIZE_LOW_DEN)
const SIZE_LOW_DEN = 2n;

/** Keeps the EMAs, the open-position bookkeeping and the cooldown clocks. */
class TrendBot {
  nBars = 0;
  emaFast: number | null = null;
  emaSlow: number | null = null;
  slowHistory: number[] = [];
  closes: number[] = [];
  inPosition = false;
  entryClose: number | null = null;
  peakClose: number | null = null;
  lastExitPeak: number | null = null; // peak close of the last completed ride
  cooldownUntil = -1;
  equityPeak: bigint | null = null;
  guardUntil = -1;

  onBatch(state: BarsState, _batch: Batch): OrderInput[] {
    if (state.warmingUp) return [];
    const closeBig = state.close(SYMBOL);
    if (closeBig === null) return [];
    const close = Number(closeBig);
    this.observe(close);
    this.syncPosition(state);

    // Equity drawdown guard: flatten and stand aside.
    if (this.equityPeak === null || state.equity > this.equityPeak) {
      this.equityPeak = state.equity;
    }
    if (
      this.inPosition &&
      this.equityPeak > 0n &&
      state.equity * 10000n < this.equityPeak * BigInt(10000 - DD_GUARD_BPS)
    ) {
      this.guardUntil = this.nBars + DD_COOLDOWN_BARS;
      return this.sellAll(state);
    }

    if (this.inPosition) return this.maybeExit(state, close);
    return this.maybeEnter(state, close);
  }

  /** Fold one close into the EMAs and the return history. */
  observe(close: number): void {
    this.nBars += 1;
    this.closes.push(close);
    if (this.emaFast === null || this.emaSlow === null) {
      this.emaFast = close;
      this.emaSlow = close;
    } else {
      const aFast = 2 / (FAST_SPAN + 1);
      const aSlow = 2 / (SLOW_SPAN + 1);
      this.emaFast = aFast * close + (1 - aFast) * this.emaFast;
      this.emaSlow = aSlow * close + (1 - aSlow) * this.emaSlow;
    }
    this.slowHistory.push(this.emaSlow);
    if (this.closes.length > VOL_WINDOW + 1) this.closes.shift();
  }

  /** Reconcile our bookkeeping with the account the harness reports. */
  syncPosition(state: BarsState): void {
    const held = state.positions.get(SYMBOL);
    if (held === undefined && this.inPosition) {
      // Position is gone (sold, flattened, or a buy that never filled):
      // forget the entry so the next buy starts clean.
      this.inPosition = false;
      this.entryClose = null;
      this.peakClose = null;
    }
    if (held !== undefined && !this.inPosition) {
      // A buy filled that we had not booked (should not happen, but stay safe).
      this.inPosition = true;
      this.entryClose = Number(state.close(SYMBOL) ?? 0n);
      this.peakClose = Number(state.close(SYMBOL) ?? 0n);
    }
  }

  /** Slow-EMA rise over SLOPE_BARS bars, in bps of the older value. */
  slowSlopeBps(): number {
    if (this.slowHistory.length <= SLOPE_BARS) return 0;
    const old = this.slowHistory[this.slowHistory.length - SLOPE_BARS - 1]!;
    const cur = this.slowHistory[this.slowHistory.length - 1]!;
    if (old <= 0) return 0;
    return ((cur - old) / old) * 10000;
  }

  /** Stdev of the last VOL_WINDOW 1-minute returns, in bps. */
  recentVolBps(): number {
    if (this.closes.length < VOL_WINDOW + 1) return 0;
    const rets: number[] = [];
    for (let i = 1; i < this.closes.length; i++) {
      const prev = this.closes[i - 1]!;
      if (prev > 0) rets.push(((this.closes[i]! - prev) / prev) * 10000);
    }
    if (rets.length < 2) return 0;
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, r) => a + (r - mean) * (r - mean), 0) / rets.length;
    return Math.sqrt(variance);
  }

  maybeEnter(state: BarsState, close: number): OrderInput[] {
    if (this.nBars < MIN_BARS) return [];
    if (this.nBars <= this.cooldownUntil || this.nBars <= this.guardUntil) return [];
    if (state.cash < 1000000n) return []; // need at least 1 USDC to buy
    const gapBps =
      ((this.emaFast! - this.emaSlow!) / this.emaSlow!) * 10000;
    if (gapBps < GAP_BPS) return [];
    if (this.slowSlopeBps() <= SLOPE_MIN_BPS) return [];
    // New-high confirmation: after an exit, only re-enter when the trend
    // resumes decisively past the peak of the ride just left — never on a
    // chop bounce or a marginal new high at the top of the range.
    if (
      this.lastExitPeak !== null &&
      close * 10000 <= this.lastExitPeak * (10000 + BREAKOUT_MARGIN_BPS)
    )
      return [];
    // Volatility-scaled size: half size when the last hour was jumpy.
    let notional = state.cash;
    if (this.recentVolBps() > VOL_HIGH_BPS) {
      notional = (state.cash * SIZE_LOW_NUM) / SIZE_LOW_DEN;
    }
    if (notional < 1000000n) return [];
    this.inPosition = true;
    this.entryClose = close;
    this.peakClose = close;
    return [
      {
        side: "buy",
        symbol: SYMBOL,
        notional_quote_units: notional,
        max_slippage_bps: MAX_SLIP_BPS,
      },
    ];
  }

  maybeExit(state: BarsState, close: number): OrderInput[] {
    if (this.peakClose !== null && close > this.peakClose) this.peakClose = close;
    const gapBps =
      ((this.emaFast! - this.emaSlow!) / this.emaSlow!) * 10000;
    const trendFlipped = gapBps < -GAP_BPS;
    const trailed =
      this.peakClose !== null &&
      close * 10000 < this.peakClose * (10000 - TRAIL_BPS);
    const stopped =
      this.entryClose !== null &&
      close * 10000 < this.entryClose * (10000 - STOP_BPS);
    const tookProfit =
      TAKE_BPS > 0 &&
      this.entryClose !== null &&
      close * 10000 > this.entryClose * (10000 + TAKE_BPS);
    if (trendFlipped || trailed || stopped || tookProfit) {
      this.cooldownUntil = this.nBars + COOLDOWN_BARS;
      return this.sellAll(state);
    }
    return [];
  }

  sellAll(state: BarsState): OrderInput[] {
    const held = state.positions.get(SYMBOL);
    if (this.peakClose !== null) this.lastExitPeak = this.peakClose;
    this.inPosition = false;
    this.entryClose = null;
    this.peakClose = null;
    if (held === undefined || held.qty <= 0n) return [];
    return [
      {
        side: "sell",
        symbol: SYMBOL,
        qty: held.qty,
        max_slippage_bps: MAX_SLIP_BPS,
      },
    ];
  }
}

await runBars(new TrendBot());
