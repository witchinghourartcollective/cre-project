// Coin circuit breaker: every 5 minutes, compare each Zora coin's Uniswap v4 pool on Base
// (price + in-range liquidity) now vs. `lookbackBlocks` ago, and trip on abnormal moves.
// local-simulation mode only logs the decision; production mode writes a signed report
// to a CoinCircuitBreaker receiver that the flywheel checks before buying.
import {
  CronCapability,
  EVMClient,
  LAST_FINALIZED_BLOCK_NUMBER,
  Runner,
  TxStatus,
  blockNumber as toBlockNumber,
  bytesToHex,
  encodeCallMsg,
  getNetwork,
  handler,
  prepareReportRequest,
  protoBigIntToBigint,
  type Runtime,
} from "@chainlink/cre-sdk";
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  isAddress,
  parseAbi,
  parseAbiParameters,
  zeroAddress,
  type Address,
} from "viem";
import { z } from "zod";
import { coinPriceE18, decide, poolIdOf, reasonName, Reason, type Observation, type PoolKey } from "./breaker";

const address = z.string().refine((v): boolean => isAddress(v, { strict: false }), "invalid address");
const uintString = z.string().regex(/^[1-9]\d*$/, "positive integer string");
const bps = z.number().int().min(1).max(10_000);

const coinSchema = z
  .object({
    symbol: z.string().min(1),
    address,
    poolKey: z
      .object({
        currency0: address,
        currency1: address,
        fee: z.number().int().min(0),
        tickSpacing: z.number().int(),
        hooks: address,
      })
      .strict(),
  })
  .strict();

const common = {
  schedule: z.string(),
  chainSelectorName: z.string(),
  stateViewAddress: address,
  lookbackBlocks: uintString,
  maxDropBps: bps,
  maxSpikeBps: bps,
  maxLiquidityDropBps: bps,
  coins: z.array(coinSchema).min(1),
};

export const configSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("local-simulation"), ...common }).strict(),
  z
    .object({
      mode: z.literal("production"),
      ...common,
      breakerAddress: address.refine((v) => v.toLowerCase() !== zeroAddress, "breakerAddress must be nonzero"),
      gasLimit: uintString,
    })
    .strict(),
]);
export type Config = z.infer<typeof configSchema>;

const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);

type BlockRef = typeof LAST_FINALIZED_BLOCK_NUMBER | ReturnType<typeof toBlockNumber>;

const observe = (
  runtime: Runtime<Config>,
  client: EVMClient,
  key: PoolKey,
  coin: Address,
  at: BlockRef,
): Observation => {
  const poolId = poolIdOf(key);
  const call = (functionName: "getSlot0" | "getLiquidity") =>
    bytesToHex(
      client
        .callContract(runtime, {
          call: encodeCallMsg({
            from: zeroAddress,
            to: runtime.config.stateViewAddress as Address,
            data: encodeFunctionData({ abi: stateViewAbi, functionName, args: [poolId] }),
          }),
          blockNumber: at,
        })
        .result().data,
    );

  const [sqrtPriceX96] = decodeFunctionResult({ abi: stateViewAbi, functionName: "getSlot0", data: call("getSlot0") });
  const liquidity = decodeFunctionResult({ abi: stateViewAbi, functionName: "getLiquidity", data: call("getLiquidity") });
  return { priceE18: coinPriceE18(sqrtPriceX96, key, coin), liquidity };
};

type CoinResult = {
  symbol: string;
  address: Address;
  reason: string;
  reasonCode: number;
  priceThenE18: string;
  priceNowE18: string;
  priceChangeBps: string;
  liquidityThen: string;
  liquidityNow: string;
  liquidityChangeBps: string | null;
};

export const onCronTrigger = (runtime: Runtime<Config>): string => {
  const cfg = runtime.config;
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: cfg.chainSelectorName });
  if (!network) throw new Error(`Unknown chain selector name: ${cfg.chainSelectorName}`);
  const client = new EVMClient(network.chainSelector.selector);

  // Anchor both observations to finalized blocks so every node reads identical state.
  const header = client.headerByNumber(runtime, { blockNumber: LAST_FINALIZED_BLOCK_NUMBER }).result().header;
  if (!header?.blockNumber) throw new Error("finalized header missing block number");
  const nowBlock = protoBigIntToBigint(header.blockNumber);
  const lookback = BigInt(cfg.lookbackBlocks);
  if (nowBlock <= lookback) throw new Error("chain shorter than lookback window");
  const thenBlock = nowBlock - lookback;
  runtime.log(`Comparing finalized block ${nowBlock} vs ${thenBlock} (${lookback} blocks back)`);

  const thresholds = {
    maxDropBps: BigInt(cfg.maxDropBps),
    maxSpikeBps: BigInt(cfg.maxSpikeBps),
    maxLiquidityDropBps: BigInt(cfg.maxLiquidityDropBps),
  };

  const results: CoinResult[] = cfg.coins.map((coin) => {
    const key = coin.poolKey as PoolKey;
    const addr = coin.address as Address;
    const then = observe(runtime, client, key, addr, toBlockNumber(thenBlock));
    const now = observe(runtime, client, key, addr, toBlockNumber(nowBlock));
    const d = decide(then, now, thresholds);
    const r: CoinResult = {
      symbol: coin.symbol,
      address: addr,
      reason: reasonName(d.reason),
      reasonCode: d.reason,
      priceThenE18: then.priceE18.toString(),
      priceNowE18: now.priceE18.toString(),
      priceChangeBps: d.priceChangeBps.toString(),
      liquidityThen: then.liquidity.toString(),
      liquidityNow: now.liquidity.toString(),
      liquidityChangeBps: d.liquidityChangeBps === null ? null : d.liquidityChangeBps.toString(),
    };
    runtime.log(
      `${coin.symbol}: price ${r.priceChangeBps} bps, liquidity ${r.liquidityChangeBps ?? "n/a"} bps -> ${r.reason}`,
    );
    return r;
  });

  const tripped = results.filter((r) => r.reasonCode !== Reason.OK);

  if (cfg.mode === "local-simulation") {
    const out = {
      mode: "local-simulation",
      nowBlock: nowBlock.toString(),
      thenBlock: thenBlock.toString(),
      wouldTrip: tripped.map((r) => `${r.symbol}:${r.reason}`),
      coins: results,
    };
    runtime.log(`local-simulation: ${tripped.length} coin(s) would trip; no report built, nothing written`);
    return JSON.stringify(out);
  }

  // ─── production: one signed report pausing every tripped coin ───
  if (tripped.length === 0) return JSON.stringify({ mode: "production", tripped: [], txHash: null });

  const observedAt = BigInt(runtime.now().getTime()) / 1000n;
  const encoded = encodeAbiParameters(parseAbiParameters("(address coin,uint8 reason,uint256 priceE18,uint256 observedAt)[]"), [
    tripped.map((r) => ({
      coin: r.address,
      reason: r.reasonCode,
      priceE18: BigInt(r.priceNowE18),
      observedAt,
    })),
  ]);
  const report = runtime.report(prepareReportRequest(encoded)).result();
  const write = client
    .writeReport(runtime, {
      receiver: cfg.breakerAddress,
      report,
      gasConfig: { gasLimit: cfg.gasLimit },
    })
    .result();
  if (write.txStatus !== TxStatus.SUCCESS) {
    throw new Error(write.errorMessage ?? `write status ${write.txStatus}`);
  }
  if (!write.txHash || write.txHash.length === 0) throw new Error("write succeeded without a transaction hash");
  const txHash = bytesToHex(write.txHash);
  runtime.log(`Breaker tripped for ${tripped.map((r) => r.symbol).join(", ")}; tx ${txHash}`);
  return JSON.stringify({ mode: "production", tripped: tripped.map((r) => r.symbol), txHash });
};

export const initWorkflow = (config: Config) => [
  handler(new CronCapability().trigger({ schedule: config.schedule }), onCronTrigger),
];

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}
