// Regenerates the coin list in coin-breaker/config.*.json from Zora: every creator coin and
// content coin of our identities (the superset of what whm-flywheel can buy; see its
// src/coins.ts IDENTITIES / EXTRA_COINS), each with its Uniswap v4 pool key. Pausing a coin
// the flywheel doesn't buy is harmless, so the breaker covers all of them.
//
// Every pool is checked onchain (initialized, coin in the key) before it is written, so the
// workflow never carries a key that doesn't exist. Read-only; sends nothing.
//
//   cd coin-breaker && bun run sync-coins          # rewrite the configs
//   cd coin-breaker && bun run sync-coins:check    # exit 1 if the configs are out of date (new posts)
//
// After a change: simulate, then `cre workflow update` (see RESULTS.md).
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { base } from "viem/chains";
import { chunk, coinIsCurrency0, decodeSlot0SqrtPrice, poolIdOf, poolStateSlots, type PoolKey } from "../coin-breaker/breaker";
import { COINS_PER_EXTSLOAD, MAX_COINS } from "../coin-breaker/main";

const ZORA_API = "https://api-sdk.zora.engineering";
const IDENTITIES = ["witchinghour", "mirrorizm", "phletch", "phunkii", "ilikeitifyoudo"];
const EXTRA_COINS: Address[] = ["0xf2813da8320ae7d5516bb325c6a69151d7a1baa1"]; // witchinghourmusic
const POOL_MANAGER: Address = "0x498581fF718922c3f8e6A244956aF099B2652b2b"; // StateView(0xa3c0…).poolManager() on Base
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const CONFIGS = ["config.local-simulation.json", "config.staging.json", "config.production.json"].map(
  (f) => new URL(`../coin-breaker/${f}`, import.meta.url),
);

type ZoraPoolKey = { token0Address: string; token1Address: string; fee: number; tickSpacing: number; hookAddress: string };
type ZoraCoin = { address: string; symbol: string; createdAt?: string; uniswapV4PoolKey?: ZoraPoolKey | null };
type Coin = { symbol: string; address: Address; poolKey: PoolKey };

const getJson = async (url: string): Promise<any> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
};
const coinByAddress = async (address: string): Promise<ZoraCoin | null> =>
  (await getJson(`${ZORA_API}/coin?address=${address}&chain=8453`)).zora20Token ?? null;

const found = new Map<string, ZoraCoin & { creator: boolean }>();
for (const handle of IDENTITIES) {
  const creator = (await getJson(`${ZORA_API}/profile?identifier=${handle}`)).profile?.creatorCoin?.address;
  if (creator) {
    const c = await coinByAddress(creator);
    if (c) found.set(c.address.toLowerCase(), { ...c, creator: true });
  }
  let after = "";
  for (let page = 0; page < 10; page += 1) {
    const created = (await getJson(`${ZORA_API}/profileCoins?identifier=${handle}&count=100${after ? `&after=${encodeURIComponent(after)}` : ""}`))
      .profile?.createdCoins;
    for (const { node } of created?.edges ?? []) {
      if (!found.has(node.address.toLowerCase())) found.set(node.address.toLowerCase(), { ...node, creator: false });
    }
    if (!created?.pageInfo?.hasNextPage || !created.pageInfo.endCursor) break;
    after = created.pageInfo.endCursor;
  }
}
for (const extra of EXTRA_COINS) {
  if (found.has(extra)) continue;
  const c = await coinByAddress(extra);
  if (c) found.set(extra, { ...c, creator: false });
}

const skipped: string[] = [];
let coins: Coin[] = [];
// Creator coins first, then newest content first, so a cut at MAX_COINS drops the oldest posts.
const ordered = [...found.values()].sort((a, b) => Number(b.creator) - Number(a.creator) || (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
for (const c of ordered) {
  const k = c.uniswapV4PoolKey;
  if (!k) {
    skipped.push(`${c.symbol} (${c.address}): no Uniswap v4 pool key`);
    continue;
  }
  const poolKey: PoolKey = {
    currency0: k.token0Address.toLowerCase() as Address,
    currency1: k.token1Address.toLowerCase() as Address,
    fee: k.fee,
    tickSpacing: k.tickSpacing,
    hooks: k.hookAddress.toLowerCase() as Address,
  };
  coinIsCurrency0(poolKey, c.address as Address); // throws if the coin isn't in its own pool key
  coins.push({ symbol: c.symbol, address: c.address.toLowerCase() as Address, poolKey });
}
if (coins.length > MAX_COINS) {
  for (const c of coins.slice(MAX_COINS)) skipped.push(`${c.symbol} (${c.address}): over MAX_COINS=${MAX_COINS}`);
  coins = coins.slice(0, MAX_COINS);
}

// Onchain check: every pool must exist now, or the workflow could never protect that coin.
const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL ?? "https://base.drpc.org") });
const extsload = parseAbi(["function extsload(bytes32[] slots) view returns (bytes32[])"]);
const live: Coin[] = [];
for (const batch of chunk(coins, COINS_PER_EXTSLOAD)) {
  const words = await client.readContract({ address: POOL_MANAGER, abi: extsload, functionName: "extsload", args: [batch.flatMap((c) => poolStateSlots(poolIdOf(c.poolKey)))] });
  batch.forEach((c, i) => {
    if (decodeSlot0SqrtPrice(words[2 * i]) === 0n) skipped.push(`${c.symbol} (${c.address}): pool not initialized onchain`);
    else live.push(c);
  });
}

const check = process.argv.includes("--check");
let stale = false;
for (const file of CONFIGS) {
  const before = readFileSync(file, "utf8");
  const { stateViewAddress: _old, coins: _coins, ...cfg } = JSON.parse(before);
  const next = JSON.stringify({ ...cfg, poolManagerAddress: POOL_MANAGER, multicall3Address: MULTICALL3, coins: live }, null, 2) + "\n";
  if (next === before) continue;
  stale = true;
  if (!check) writeFileSync(file, next);
}

console.log(`${live.length} coins with live pools (${coins.filter((c) => c.poolKey.currency0 === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913").length} USDC-paired)`);
for (const s of skipped) console.log(`skipped: ${s}`);
if (check) {
  console.log(stale ? "configs are OUT OF DATE: run: cd coin-breaker && bun run sync-coins" : "configs up to date");
  process.exit(stale ? 1 : 0);
}
console.log(stale ? "configs updated" : "configs already up to date");
