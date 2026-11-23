// Trend-following bot for cbBTC/USDC on make.fun (agent-fun/bars-replay/v1).
//
// Idea, in one paragraph: BTC trends in multi-hour waves, and a full-size
// round trip costs about 26 bps in fees, slippage and price impact, so the
// bot only trades when a trend is clearly established and then rides it.
// It buys the whole cash balance once the 12-bar EMA has closed above the
// 21-bar EMA for two bars running, and it sells everything when the fast
// EMA falls 20 bps below the slow EMA (a real reversal, not noise) or when
// the price drops 3% from the highest close since entry (a trailing stop
// that caps the damage if the race window turns into a rout). It never
// opens a new position in the last hour of the window, where a trade could
// not possibly earn its round-trip cost back. One open position at most,
// long only, no leverage, no randomness, no clock: every decision is a pure
// function of the closes seen so far, so two runs on the same bars agree
// order for order.

import { runBars } from "./vendor/makefun-bars.ts";
import type { BarsState, Batch, OrderInput } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";

// Trend filter: fast/slow EMA lengths (minutes).
const FAST_LEN = 12;
const SLOW_LEN = 21;
// Entry needs the fast EMA above the slow EMA for this many closes in a row.
const CONFIRM_BARS = 2;
// Exit when (fast / slow - 1) falls below -EXIT_BPS bps.
const EXIT_BPS = 20;
// Trailing stop: sell when the close falls this far below the highest close
// seen while holding.
const TRAIL_STOP = 0.03;
// Never open a new position this many bars into the scored window or later
// (the last hour cannot repay a round trip).
const NO_ENTRY_AFTER_BAR = 1380;
// Slippage guard on every order: the biggest 1-minute move in the dev window
// was 72 bps, so 150 bps leaves room for a gap plus slippage plus impact
// while still refusing a fill on a wild print.
const MAX_SLIPPAGE_BPS = 150;

// --- strategy state (derived only from bars the harness has sent) --------

let fastEma: number | null = null;
let slowEma: number | null = null;
// Consecutive closes with the fast EMA above the slow EMA, while flat.
let upRun = 0;
// Highest close seen since the current position was opened (0 when flat).
let peakSinceEntry = 0;

function emaStep(prev: number | null, price: number, len: number): number {
  if (prev === null) return price;
  const k = 2 / (len + 1);
  return price * k + prev * (1 - k);
}

function decide(state: BarsState, batch: Batch): OrderInput[] {
  // No bar for our symbol this minute: no new information, no orders.
  if (!batch.bars.some((b) => b.symbol === SYMBOL)) return [];
  // Warm-up bars exist only to build history; orders on them are rejected.
  if (state.warmingUp) {
    const close = Number(state.close(SYMBOL));
    fastEma = emaStep(fastEma, close, FAST_LEN);
    slowEma = emaStep(slowEma, close, SLOW_LEN);
    return [];
  }

  const close = Number(state.close(SYMBOL));
  fastEma = emaStep(fastEma, close, FAST_LEN);
  slowEma = emaStep(slowEma, close, SLOW_LEN);
  if (fastEma === null || slowEma === null) return [];

  const held = state.positions.get(SYMBOL);
  const qty = held === undefined ? 0n : held.qty;

  if (qty > 0n) {
    // Holding: track the peak and check the two exit conditions.
    if (close > peakSinceEntry) peakSinceEntry = close;
    const spreadBps = (fastEma / slowEma - 1) * 10_000;
    const reversed = spreadBps < -EXIT_BPS;
    const stoppedOut = peakSinceEntry > 0 && close < peakSinceEntry * (1 - TRAIL_STOP);
    if (reversed || stoppedOut) {
      peakSinceEntry = 0;
      return [{ side: "sell", symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }

  // Flat: count consecutive closes with the trend pointing up.
  peakSinceEntry = 0;
  if (fastEma > slowEma) {
    upRun += 1;
  } else {
    upRun = 0;
  }
  const late = state.seq >= state.warmupBars + NO_ENTRY_AFTER_BAR;
  if (upRun >= CONFIRM_BARS && !late && state.cash > 0n) {
    // Full size: one position, 100% of cash. The harness fills this at the
    // next bar's open, against that bar's pool depth.
    return [{ side: "buy", symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }
  return [];
}

await runBars({
  onBatch(state, batch) {
    return decide(state, batch);
  },
});
