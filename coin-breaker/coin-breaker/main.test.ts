import { describe, expect, test } from "bun:test";
import {
  changeBps,
  chunk,
  coinIsCurrency0,
  coinPriceE18,
  decide,
  decodeLiquidity,
  decodeSlot0SqrtPrice,
  poolIdOf,
  poolStateSlots,
  priceChangeBps,
  Reason,
  type PoolKey,
} from "./breaker";
import { COINS_PER_EXTSLOAD, MAX_COINS, PAUSE_CHECKS_PER_MULTICALL, configSchema, initWorkflow, readBudget } from "./main";
import productionConfig from "./config.production.json";
import localConfig from "./config.local-simulation.json";
import stagingConfig from "./config.staging.json";

const ZORA = "0x1111111111166b7fe7bd91427724b487980afc69";
const WITCHINGHOUR = "0x3514e89c79ccd1bbc32f133f10fd2d760e090964";
const key: PoolKey = {
  currency0: ZORA,
  currency1: WITCHINGHOUR,
  fee: 8388608,
  tickSpacing: 200,
  hooks: "0x0469a4bd3724dc86c9542f4694c976da13c450c0",
};
const T = { maxDropBps: 1500n, maxSpikeBps: 3000n, maxLiquidityDropBps: 5000n };

describe("poolIdOf", () => {
  test("matches the witchinghour pool id indexed by GeckoTerminal", () => {
    expect(poolIdOf(key)).toBe("0x9f63f0a7c0feacd3118dc1a41f8517e46b00db0f3e9155cab5b35e191192287a");
  });
});

describe("coinPriceE18", () => {
  test("sqrtPriceX96 = 2^96 is price 1 on either side", () => {
    expect(coinPriceE18(1n << 96n, key, WITCHINGHOUR)).toBe(10n ** 18n);
    expect(coinPriceE18(1n << 96n, key, ZORA)).toBe(10n ** 18n);
  });
  test("coin as currency1 inverts: 4x sqrt^2 means 1/4 the coin price", () => {
    expect(coinPriceE18(2n << 96n, key, WITCHINGHOUR)).toBe(10n ** 18n / 4n);
  });
  test("rejects uninitialized pools and foreign coins", () => {
    expect(() => coinPriceE18(0n, key, WITCHINGHOUR)).toThrow();
    expect(() => coinPriceE18(1n << 96n, key, "0x0000000000000000000000000000000000000001")).toThrow();
  });
});

describe("changeBps", () => {
  test("signed basis points", () => {
    expect(changeBps(100n, 85n)).toBe(-1500n);
    expect(changeBps(100n, 130n)).toBe(3000n);
    expect(() => changeBps(0n, 1n)).toThrow();
  });
});

describe("priceChangeBps (exact, from sqrtPrice)", () => {
  const Q = 1n << 96n;
  test("coin as currency0: price follows sqrtPrice^2", () => {
    expect(priceChangeBps(10n * Q, 9n * Q, true)).toBe(-1900n); // 0.81x
    expect(priceChangeBps(10n * Q, 11n * Q, true)).toBe(2100n); // 1.21x
  });
  test("coin as currency1: price follows 1/sqrtPrice^2", () => {
    expect(priceChangeBps(10n * Q, 11n * Q, false)).toBe(-1735n); // 100/121 - 1 = -17.36%
    expect(priceChangeBps(10n * Q, 9n * Q, false)).toBe(2345n); // 100/81 - 1 = +23.46%
  });
  test("keeps precision where coinPriceE18 rounds to zero (tiny coin in a 6-decimal USDC pool)", () => {
    const usdcKey: PoolKey = { ...key, currency0: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", currency1: WITCHINGHOUR };
    const sqrt = 9n << 136n; // coin worth ~1e-24 USDC raw units per raw coin unit
    expect(coinPriceE18(sqrt, usdcKey, WITCHINGHOUR)).toBe(0n);
    expect(priceChangeBps(sqrt, 10n << 136n, false)).toBe(-1900n); // (9/10)^2 = 0.81x
  });
});

describe("decide", () => {
  const Q = 1n << 96n;
  const base = { sqrtPriceX96: 100n * Q, liquidity: 1000n };
  // Coin as currency0 so price change = sqrt ratio squared.
  const at = (sqrtPct: bigint, liquidity: bigint) => ({ sqrtPriceX96: sqrtPct * Q, liquidity });
  test("normal moves stay OK", () => {
    expect(decide(base, at(104n, 990n), true, T).reason).toBe(Reason.OK); // +8.16%
    expect(decide(base, at(93n, 1000n), true, T).reason).toBe(Reason.OK); // -13.51%
  });
  test("thresholds trip", () => {
    expect(decide(base, at(92n, 1000n), true, T).reason).toBe(Reason.PRICE_DROP); // -15.36%
    expect(decide(base, at(115n, 1000n), true, T).reason).toBe(Reason.PRICE_SPIKE); // +32.25%
    expect(decide(base, at(100n, 500n), true, T).reason).toBe(Reason.LIQUIDITY_DROP); // exactly -50%
  });
  test("the same sqrt move is a drop for a currency1 coin", () => {
    expect(decide(base, at(110n, 1000n), false, T).reason).toBe(Reason.PRICE_DROP); // -17.36%
  });
  test("zero liquidity outranks everything", () => {
    expect(decide(base, at(10n, 0n), true, T).reason).toBe(Reason.NO_LIQUIDITY);
  });
  test("a pool created inside the window is NEW, not a failure", () => {
    const d = decide({ sqrtPriceX96: 0n, liquidity: 0n }, base, true, T);
    expect(d).toEqual({ reason: Reason.OK, priceChangeBps: null, liquidityChangeBps: null, note: "NEW" });
  });
  test("a pool that doesn't exist is UNINITIALIZED and never throws", () => {
    expect(decide({ sqrtPriceX96: 0n, liquidity: 0n }, { sqrtPriceX96: 0n, liquidity: 0n }, true, T).note).toBe("UNINITIALIZED");
  });
});

describe("PoolManager extsload layout", () => {
  test("slots for the witchinghour pool (values read on Base matched StateView on 2026-10-06)", () => {
    const [slot0, liquidity] = poolStateSlots(poolIdOf(key));
    expect(BigInt(liquidity) - BigInt(slot0)).toBe(3n);
    expect(slot0).toMatch(/^0x[0-9a-f]{64}$/);
  });
  test("decoders mask the packed fields", () => {
    const tickAndFees = (0xabcdefn << 160n) | 12345n;
    expect(decodeSlot0SqrtPrice(`0x${tickAndFees.toString(16).padStart(64, "0")}`)).toBe(12345n);
    const upper = (1n << 200n) | 777n;
    expect(decodeLiquidity(`0x${upper.toString(16).padStart(64, "0")}`)).toBe(777n);
  });
  test("coinIsCurrency0 rejects a coin outside its pool key", () => {
    expect(coinIsCurrency0(key, ZORA)).toBe(true);
    expect(coinIsCurrency0(key, WITCHINGHOUR)).toBe(false);
    expect(() => coinIsCurrency0(key, "0x0000000000000000000000000000000000000001")).toThrow();
  });
});

describe("CRE quotas", () => {
  test("worst case stays inside 15 EVM reads per execution", () => {
    expect(readBudget(MAX_COINS, MAX_COINS)).toBeLessThanOrEqual(15);
    expect(readBudget(productionConfig.coins.length, productionConfig.coins.length)).toBeLessThanOrEqual(15);
  });
  test("each read request stays under 5 KB", () => {
    expect(4 + 64 + COINS_PER_EXTSLOAD * 2 * 32).toBeLessThan(5_000);
    expect(4 + 64 + PAUSE_CHECKS_PER_MULTICALL * 224).toBeLessThan(5_000);
  });
  test("chunk splits evenly and keeps order", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe("config", () => {
  test("local-simulation config parses and registers one cron handler", () => {
    const cfg = configSchema.parse(localConfig);
    expect(cfg.mode).toBe("local-simulation");
    const handlers = initWorkflow(cfg);
    expect(handlers).toHaveLength(1);
    expect(handlers[0].trigger.config.schedule).toBe("0 */5 * * * *");
  });
  test("production configs point at the deployed Base breaker and reject a zero/missing receiver", () => {
    const cfg = configSchema.parse(stagingConfig);
    expect(cfg.mode).toBe("production");
    if (cfg.mode === "production") expect(cfg.breakerAddress).toBe("0xBFeDCca4dE6cF908C1cf375D430DaDDc15C9bdca");
    expect(() => configSchema.parse({ ...stagingConfig, breakerAddress: "0x0000000000000000000000000000000000000000" })).toThrow();
    expect(() => configSchema.parse({ ...stagingConfig, breakerAddress: "" })).toThrow();
  });
  test("all configs carry the same synced coin list, and too many coins are rejected", () => {
    expect(productionConfig.coins).toEqual(localConfig.coins);
    expect(stagingConfig.coins).toEqual(localConfig.coins);
    expect(localConfig.coins.length).toBeGreaterThan(2);
    const many = Array.from({ length: MAX_COINS + 1 }, () => localConfig.coins[0]);
    expect(() => configSchema.parse({ ...localConfig, coins: many })).toThrow();
  });
  test("local config cannot smuggle in a receiver", () => {
    expect(() => configSchema.parse({ ...localConfig, breakerAddress: WITCHINGHOUR })).toThrow();
  });
});
