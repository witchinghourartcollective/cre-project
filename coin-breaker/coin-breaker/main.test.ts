import { describe, expect, test } from "bun:test";
import { changeBps, coinPriceE18, decide, poolIdOf, Reason, type PoolKey } from "./breaker";
import { configSchema, initWorkflow } from "./main";
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

describe("decide", () => {
  const base = { priceE18: 1000n, liquidity: 1000n };
  test("normal moves stay OK", () => {
    expect(decide(base, { priceE18: 1090n, liquidity: 990n }, T).reason).toBe(Reason.OK);
    expect(decide(base, { priceE18: 860n, liquidity: 1000n }, T).reason).toBe(Reason.OK);
  });
  test("threshold boundaries trip exactly at the limit", () => {
    expect(decide(base, { priceE18: 850n, liquidity: 1000n }, T).reason).toBe(Reason.PRICE_DROP);
    expect(decide(base, { priceE18: 1300n, liquidity: 1000n }, T).reason).toBe(Reason.PRICE_SPIKE);
    expect(decide(base, { priceE18: 1000n, liquidity: 500n }, T).reason).toBe(Reason.LIQUIDITY_DROP);
  });
  test("zero liquidity outranks everything", () => {
    expect(decide(base, { priceE18: 100n, liquidity: 0n }, T).reason).toBe(Reason.NO_LIQUIDITY);
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
  test("local config cannot smuggle in a receiver", () => {
    expect(() => configSchema.parse({ ...localConfig, breakerAddress: WITCHINGHOUR })).toThrow();
  });
});
