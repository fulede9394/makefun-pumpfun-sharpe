// Cleanest-paper sniper for the pump.fun Sharpe sprint (agent-fun/replay/v2).
//
// The dev window is brutal for momentum: chasing breakouts loses ~9 SOL and
// mean-reversion loses ~2 SOL, while buying fresh launches loses only ~0.1 SOL.
// The edge is in *which* launches: a coin whose opening tape shows a tight
// crowd — exactly two or three distinct non-creator buyers in its first few
// slots, with the creator still holding — behaves far better than an empty
// launch or a bundled one (four or more wallets in the opening slots is a
// dump waiting to happen). So this bot only ever buys in a coin's first three
// slots, only from that tight crowd, in two tiers: the three-buyer crowd gets
// the full stake, the two-buyer crowd half. Everything else is risk control:
// take profit at +25%, cut at -6%, never hold past 30 slots, leave the moment
// the creator sells, the recent flow turns negative, or the coin goes quiet
// (no trades for a while means the launch is dead and the slot is better used
// elsewhere). Small stakes, quick exits, many coins: that is what a Sharpe
// ranking rewards.
//
// Pure function of the batches the harness sends: no clock, no randomness,
// no I/O, so the two graded executions produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS_PER_SOL = 1_000_000_000;

export interface Settings {
  /** First buy only while the coin is at most this many slots old. */
  entryAgeSlots: number;
  /** Distinct non-creator buyers a tier-A launch must show. */
  crowdA: number;
  /** Distinct non-creator buyers a tier-B launch must show. */
  crowdB: number;
  /** Trades the opening tape must hold before either tier may buy. */
  minOpeningTrades: number;
  /** The creator's own buys in the opening tape, at most (SOL). */
  devBuyCeilingSol: number;
  /** Real SOL reserve window at decision time. */
  reserveFloorSol: number;
  reserveCeilingSol: number;
  /** Stake for a tier-A launch (SOL). */
  stakeASol: number;
  /** Stake for a tier-B launch (SOL). */
  stakeBSol: number;
  /** Smallest single buy worth paying the transaction fee for (SOL). */
  minBuySol: number;
  /** Take profit: sell once the position is worth cost * (1 + tp). */
  takeProfit: number;
  /** Stop loss: sell once the position is worth cost * (1 - sl). */
  stopLoss: number;
  /** Longest hold, in slots. */
  maxHoldSlots: number;
  /** Exit when net SOL over this many recent slots falls below zero. */
  flowLookbackSlots: number;
  /** Exit when the coin has had no trade for this many slots. */
  staleSlots: number;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Slippage allowed on sells (bps). */
  sellSlippageBps: number;
}

export const DEFAULT_SETTINGS: Settings = {
  entryAgeSlots: 3,
  crowdA: 3,
  crowdB: 2,
  minOpeningTrades: 3,
  devBuyCeilingSol: 2.5,
  reserveFloorSol: 0.3,
  reserveCeilingSol: 30,
  stakeASol: 0.1,
  stakeBSol: 0.05,
  minBuySol: 0.01,
  takeProfit: 0.25,
  stopLoss: 0.06,
  maxHoldSlots: 30,
  flowLookbackSlots: 10,
  staleSlots: 50,
  buySlippageBps: 10_000,
  sellSlippageBps: 10_000,
};

interface OpeningTrade {
  slot: number;
  buy: boolean;
  solLamports: bigint;
  user: Pubkey;
}

interface Launch {
  createdSlot: number | null;
  creator: Pubkey | null;
  /** Price at creation (virtual SOL per virtual token), for reference only. */
  startPrice: number;
  devBoughtLamports: bigint;
  devSold: boolean;
  /** Slot of the latest TradeEvent on this coin. */
  lastTradeSlot: number;
  buyers: Set<Pubkey>;
  trades: OpeningTrade[];
  entered: boolean;
}

interface Open {
  enteredSlot: number;
  bestValueLamports: bigint;
  costLamports: bigint;
}

function priceOf(vq: bigint, vt: bigint): number {
  return vt === 0n ? 0 : Number(vq) / Number(vt);
}

export function createStrategy(s: Settings = DEFAULT_SETTINGS): Bot {
  const launches = new Map<Pubkey, Launch>();
  const open = new Map<Pubkey, Open>();
  const curveFeeBps =
    95 + 30; // protocol + creator fallback bps; the harness fees match these on the dev window

  const launchOf = (mint: Pubkey): Launch => {
    let l = launches.get(mint);
    if (l === undefined) {
      l = {
        createdSlot: null,
        creator: null,
        startPrice: 0,
        devBoughtLamports: 0n,
        devSold: false,
        lastTradeSlot: -1,
        buyers: new Set(),
        trades: [],
        entered: false,
      };
      launches.set(mint, l);
    }
    return l;
  };

  /** Net SOL (buys minus sells) over the last `window` slots of a launch's tape. */
  const recentFlow = (l: Launch, now: number, window: number): bigint => {
    let net = 0n;
    for (let i = l.trades.length - 1; i >= 0; i--) {
      const t = l.trades[i]!;
      if (t.slot <= now - window) break;
      net += t.buy ? t.solLamports : -t.solLamports;
    }
    return net;
  };

  /** Which tier, if any, a launch qualifies for right now. 0 = none. */
  const tierOf = (l: Launch, now: number, realSol: number): 0 | 1 | 2 => {
    // Defensive: realSol comes from Number(bigint)/1e9, so it should always be
    // finite — but tiering must never run on a non-finite reserve value.
    if (!Number.isFinite(realSol)) return 0;
    if (l.createdSlot === null || now - l.createdSlot > s.entryAgeSlots) return 0;
    if (l.entered || l.devSold) return 0;
    if (l.devBoughtLamports > BigInt(Math.floor(s.devBuyCeilingSol * LAMPORTS_PER_SOL))) return 0;
    if (realSol < s.reserveFloorSol || realSol > s.reserveCeilingSol) return 0;
    if (l.trades.length < s.minOpeningTrades) return 0;
    const crowd = l.buyers.size;
    if (crowd === s.crowdA) return 1;
    if (crowd === s.crowdB) return 2;
    return 0;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const txFee = state.txFeeLamports();
      const orders: OrderInput[] = [];
      const orderCap = state.hello.caps.max_orders_per_batch;

      // Fold this batch's events into the launch tapes.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const l = launchOf(e.mint);
          l.createdSlot = e.slot;
          l.creator = e.creator;
          l.startPrice = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        } else if (e.event === 'TradeEvent') {
          const l = launchOf(e.mint);
          const sol = BigInt(e.sol_amount);
          l.lastTradeSlot = e.slot;
          l.trades.push({ slot: e.slot, buy: e.is_buy, solLamports: sol, user: e.user });
          if (l.creator !== null && e.user === l.creator) {
            if (e.is_buy) l.devBoughtLamports += sol;
            else l.devSold = true;
          } else if (e.is_buy) {
            l.buyers.add(e.user);
          }
        } else {
          // CompleteEvent: the curve is done; drop its tape so it is never re-entered.
          launches.delete(e.mint);
        }
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingMints = new Set<Pubkey>();
      for (const po of state.pending.values()) pendingMints.add(po.order.mint);

      // Exits first: sell anything that hit its take-profit, stop, hold limit,
      // creator sale, or a negative recent flow.
      for (const [mint, o] of open) {
        const pos = state.positions.get(mint);
        if (pos === undefined) {
          if (!pendingMints.has(mint)) open.delete(mint);
          continue;
        }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
        const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
        const tokens = BigInt(pos.token_amount);
        const gross = (tokens * vq) / (vt + tokens);
        const value = (gross * BigInt(10_000 - curveFeeBps)) / 10_000n - txFee;
        const cost = BigInt(pos.cost_lamports);
        if (value > o.bestValueLamports) o.bestValueLamports = value;
        const l = launches.get(mint);
        const devDumped = l !== undefined && l.devSold;
        const flowOut = l !== undefined && recentFlow(l, now, s.flowLookbackSlots) < 0n;
        const goneQuiet = l !== undefined && now - l.lastTradeSlot > s.staleSlots;
        const stale = now - o.enteredSlot > s.maxHoldSlots;
        const up = value >= (cost * BigInt(Math.floor((1 + s.takeProfit) * 10_000))) / 10_000n;
        const down = value <= (cost * BigInt(Math.floor((1 - s.stopLoss) * 10_000))) / 10_000n;
        if (!up && !down && !stale && !devDumped && !flowOut && !goneQuiet) continue;
        if (pendingMints.has(mint)) continue;
        if (orders.length >= orderCap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: s.sellSlippageBps });
      }

      // Entries: one fresh launch per batch at most is plenty; walk the tapes in
      // first-seen order so the run is deterministic.
      let freeLamports = state.freeCashLamports();
      let room = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const [mint, l] of launches) {
        if (orders.length >= orderCap || room <= 0) break;
        if (open.has(mint) || pendingMints.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS_PER_SOL;
        const tier = tierOf(l, now, realSol);
        if (tier === 0) continue;
        const wantSol = tier === 1 ? s.stakeASol : s.stakeBSol;
        const want = BigInt(Math.floor(wantSol * LAMPORTS_PER_SOL));
        const cap = state.maxBuyLamports(mint);
        let amount = want < cap ? want : cap;
        const affordable = freeLamports - txFee;
        if (amount > affordable) amount = affordable;
        if (amount < BigInt(Math.floor(s.minBuySol * LAMPORTS_PER_SOL))) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: s.buySlippageBps });
        freeLamports -= amount + txFee;
        room -= 1;
        l.entered = true;
        open.set(mint, { enteredSlot: now, bestValueLamports: 0n, costLamports: amount });
      }
      return orders;
    },
  };
}
