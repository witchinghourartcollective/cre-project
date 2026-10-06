// Pure, deterministic circuit-breaker math. No CRE runtime access here so it can be unit-tested.
import { encodeAbiParameters, encodePacked, hexToBigInt, keccak256, toHex, type Address, type Hex } from "viem";

export type PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

export type Thresholds = {
  maxDropBps: bigint;
  maxSpikeBps: bigint;
  maxLiquidityDropBps: bigint;
};

// Reason codes are part of the onchain report format; keep in sync with CoinCircuitBreaker.sol.
export const Reason = {
  OK: 0,
  PRICE_DROP: 1,
  PRICE_SPIKE: 2,
  LIQUIDITY_DROP: 3,
  NO_LIQUIDITY: 4,
} as const;
export type ReasonCode = (typeof Reason)[keyof typeof Reason];
export const reasonName = (r: ReasonCode): string =>
  (Object.keys(Reason) as (keyof typeof Reason)[]).find((k) => Reason[k] === r) ?? "UNKNOWN";

const Q192 = 1n << 192n;
const E18 = 10n ** 18n;
const BPS = 10_000n;

/** Uniswap v4 PoolId = keccak256(abi.encode(PoolKey)). */
export const poolIdOf = (key: PoolKey): Hex =>
  keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );

/**
 * Storage slots of a pool's state in the Uniswap v4 PoolManager, read with `extsload` (the same
 * layout StateView/StateLibrary use): `pools` is mapping slot 6; Slot0 is the first word of the
 * pool's State and liquidity is 3 words after it.
 */
const POOLS_SLOT = 6n;
const LIQUIDITY_OFFSET = 3n;
export const poolStateSlots = (poolId: Hex): [Hex, Hex] => {
  const slot0 = keccak256(encodePacked(["bytes32", "uint256"], [poolId, POOLS_SLOT]));
  return [slot0, toHex(hexToBigInt(slot0) + LIQUIDITY_OFFSET, { size: 32 })];
};
/** sqrtPriceX96 is the low 160 bits of Slot0; liquidity is the low 128 bits of its word. */
export const decodeSlot0SqrtPrice = (word: Hex): bigint => hexToBigInt(word) & ((1n << 160n) - 1n);
export const decodeLiquidity = (word: Hex): bigint => hexToBigInt(word) & ((1n << 128n) - 1n);

export const coinIsCurrency0 = (key: PoolKey, coin: Address): boolean => {
  const c = coin.toLowerCase();
  if (c === key.currency0.toLowerCase()) return true;
  if (c === key.currency1.toLowerCase()) return false;
  throw new Error(`coin ${coin} is not in pool key`);
};

/**
 * Price of `coin` in the pool's other currency, scaled by 1e18, in raw token units. Reported
 * onchain for information only (it can round to 0 for tiny prices in a 6-decimal USDC pool);
 * trip decisions use the exact sqrtPrice ratio in `priceChangeBps`.
 */
export const coinPriceE18 = (sqrtPriceX96: bigint, key: PoolKey, coin: Address): bigint => {
  if (sqrtPriceX96 <= 0n) throw new Error("pool not initialized (sqrtPriceX96 = 0)");
  const sq = sqrtPriceX96 * sqrtPriceX96;
  return coinIsCurrency0(key, coin) ? (sq * E18) / Q192 : (Q192 * E18) / sq;
};

/** Signed change from `before` to `after` in basis points (truncated toward zero). */
export const changeBps = (before: bigint, after: bigint): bigint => {
  if (before <= 0n) throw new Error("baseline must be positive");
  return ((after - before) * BPS) / before;
};

/**
 * Exact change of the coin's price in bps from two sqrtPrices. sqrtPrice^2 is currency1 per
 * currency0, so the coin's price is proportional to sq when it is currency0, and to 1/sq when
 * it is currency1: (1/now - 1/then) / (1/then) = (then - now) / now.
 */
export const priceChangeBps = (thenSqrt: bigint, nowSqrt: bigint, isCurrency0: boolean): bigint => {
  const sqThen = thenSqrt * thenSqrt;
  const sqNow = nowSqrt * nowSqrt;
  return isCurrency0 ? changeBps(sqThen, sqNow) : ((sqThen - sqNow) * BPS) / sqNow;
};

export type Observation = { sqrtPriceX96: bigint; liquidity: bigint };

export type Decision = {
  reason: ReasonCode;
  /** null when there is no baseline: the pool did not exist then (NEW) or does not exist now. */
  priceChangeBps: bigint | null;
  liquidityChangeBps: bigint | null;
  note: "NEW" | "UNINITIALIZED" | null;
};

/** First matching reason wins; order is most to least severe. */
export const decide = (then: Observation, now: Observation, isCurrency0: boolean, t: Thresholds): Decision => {
  // A pool created inside the lookback window has no baseline yet; a key that never existed is
  // a config problem the sync script rejects. Neither may stop the other coins being checked.
  if (now.sqrtPriceX96 === 0n) return { reason: Reason.OK, priceChangeBps: null, liquidityChangeBps: null, note: "UNINITIALIZED" };
  if (then.sqrtPriceX96 === 0n) return { reason: Reason.OK, priceChangeBps: null, liquidityChangeBps: null, note: "NEW" };

  const price = priceChangeBps(then.sqrtPriceX96, now.sqrtPriceX96, isCurrency0);
  const liquidityChangeBps = then.liquidity > 0n ? changeBps(then.liquidity, now.liquidity) : null;

  let reason: ReasonCode = Reason.OK;
  if (now.liquidity === 0n) reason = Reason.NO_LIQUIDITY;
  else if (liquidityChangeBps !== null && -liquidityChangeBps >= t.maxLiquidityDropBps) reason = Reason.LIQUIDITY_DROP;
  else if (-price >= t.maxDropBps) reason = Reason.PRICE_DROP;
  else if (price >= t.maxSpikeBps) reason = Reason.PRICE_SPIKE;

  return { reason, priceChangeBps: price, liquidityChangeBps, note: null };
};

export const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};
