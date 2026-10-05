// Pure, deterministic circuit-breaker math. No CRE runtime access here so it can be unit-tested.
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

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
 * Price of `coin` in the pool's other currency, scaled by 1e18, in raw token units.
 * sqrtPriceX96^2 / 2^192 is currency1-per-currency0, so invert it when the coin is currency1.
 * Raw units are exact for ZORA-paired Zora coins (both 18 decimals); thresholds are ratios either way.
 */
export const coinPriceE18 = (sqrtPriceX96: bigint, key: PoolKey, coin: Address): bigint => {
  if (sqrtPriceX96 <= 0n) throw new Error("pool not initialized (sqrtPriceX96 = 0)");
  const sq = sqrtPriceX96 * sqrtPriceX96;
  const c = coin.toLowerCase();
  if (c === key.currency1.toLowerCase()) return (Q192 * E18) / sq;
  if (c === key.currency0.toLowerCase()) return (sq * E18) / Q192;
  throw new Error(`coin ${coin} is not in pool key`);
};

/** Signed change from `before` to `after` in basis points (truncated toward zero). */
export const changeBps = (before: bigint, after: bigint): bigint => {
  if (before <= 0n) throw new Error("baseline must be positive");
  return ((after - before) * BPS) / before;
};

export type Observation = { priceE18: bigint; liquidity: bigint };

export type Decision = {
  reason: ReasonCode;
  priceChangeBps: bigint;
  liquidityChangeBps: bigint | null;
};

/** First matching reason wins; order is most to least severe. */
export const decide = (then: Observation, now: Observation, t: Thresholds): Decision => {
  const priceChangeBps = changeBps(then.priceE18, now.priceE18);
  const liquidityChangeBps = then.liquidity > 0n ? changeBps(then.liquidity, now.liquidity) : null;

  let reason: ReasonCode = Reason.OK;
  if (now.liquidity === 0n) reason = Reason.NO_LIQUIDITY;
  else if (liquidityChangeBps !== null && -liquidityChangeBps >= t.maxLiquidityDropBps) reason = Reason.LIQUIDITY_DROP;
  else if (-priceChangeBps >= t.maxDropBps) reason = Reason.PRICE_DROP;
  else if (priceChangeBps >= t.maxSpikeBps) reason = Reason.PRICE_SPIKE;

  return { reason, priceChangeBps, liquidityChangeBps };
};
