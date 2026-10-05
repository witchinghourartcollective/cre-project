// LOCAL ANVIL FORK ONLY. Simulates a large holder dumping a Zora coin into its Uniswap v4 pool
// so the coin-breaker workflow can be watched tripping. Refuses to run against anything but
// a localhost anvil fork of Base; it impersonates the holder and never touches a private key.
//
// Usage: bun scripts/fork-dump.ts <coinAddress> <holderAddress> [fractionOfBalanceBps=10000]
import {
  createTestClient,
  createWalletClient,
  createPublicClient,
  encodeAbiParameters,
  encodePacked,
  erc20Abi,
  http,
  parseAbi,
  publicActions,
  type Address,
} from "viem";
import { base } from "viem/chains";

const RPC = "http://127.0.0.1:8546";
const ZORA: Address = "0x1111111111166b7fe7bd91427724b487980afc69";
const HOOKS: Address = "0x0469a4bd3724dc86c9542f4694c976da13c450c0";
const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const UNIVERSAL_ROUTER: Address = "0x6fF5693b99212Da76ad316178A184AB56D299b43";

const [coin, holder, bpsArg] = process.argv.slice(2) as [Address, Address, string?];
if (!coin || !holder) throw new Error("usage: fork-dump.ts <coin> <holder> [bps]");
const fractionBps = BigInt(bpsArg ?? "10000");

const pub = createPublicClient({ chain: base, transport: http(RPC, { timeout: 600_000 }) });
const test = createTestClient({ chain: base, mode: "anvil", transport: http(RPC, { timeout: 600_000 }) }).extend(publicActions);
const wallet = createWalletClient({ chain: base, account: holder, transport: http(RPC, { timeout: 600_000 }) });

// Safety: only ever run against a local anvil (anvil_nodeInfo exists only there).
await test.request({ method: "anvil_nodeInfo" as never }).catch(() => {
  throw new Error(`${RPC} is not an anvil node; refusing`);
});

const balance = await pub.readContract({ address: coin, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
const amountIn = (balance * fractionBps) / 10_000n;
console.log(`holder ${holder} balance ${balance / 10n ** 18n} coins; dumping ${amountIn / 10n ** 18n}`);

await test.impersonateAccount({ address: holder });
await test.setBalance({ address: holder, value: 10n ** 18n });

const send = async (to: Address, data: `0x${string}`) => {
  const hash = await wallet.sendTransaction({ to, data, chain: base, account: holder });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`tx ${hash} reverted`);
  return hash;
};

const { encodeFunctionData } = await import("viem");
await send(coin, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PERMIT2, amountIn] }));
await send(
  PERMIT2,
  encodeFunctionData({
    abi: parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]),
    functionName: "approve",
    args: [coin, UNIVERSAL_ROUTER, amountIn, 2 ** 47],
  }),
);

// V4_SWAP (0x10) with actions SWAP_EXACT_IN_SINGLE (0x06), SETTLE_ALL (0x0c), TAKE_ALL (0x0f).
const poolKey = { currency0: ZORA, currency1: coin, fee: 8388608, tickSpacing: 200, hooks: HOOKS };
const swapParams = encodeAbiParameters(
  [
    {
      type: "tuple",
      components: [
        {
          name: "poolKey",
          type: "tuple",
          components: [
            { name: "currency0", type: "address" },
            { name: "currency1", type: "address" },
            { name: "fee", type: "uint24" },
            { name: "tickSpacing", type: "int24" },
            { name: "hooks", type: "address" },
          ],
        },
        { name: "zeroForOne", type: "bool" },
        { name: "amountIn", type: "uint128" },
        { name: "amountOutMinimum", type: "uint128" },
        { name: "hookData", type: "bytes" },
      ],
    },
  ],
  [{ poolKey, zeroForOne: false, amountIn, amountOutMinimum: 0n, hookData: "0x" }],
);
const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [coin, amountIn]);
const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [ZORA, 0n]);
const v4Input = encodeAbiParameters(
  [{ type: "bytes" }, { type: "bytes[]" }],
  [encodePacked(["uint8", "uint8", "uint8"], [0x06, 0x0c, 0x0f]), [swapParams, settle, take]],
);

const zoraBefore = await pub.readContract({ address: ZORA, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
const block = await pub.getBlock();
const hash = await send(
  UNIVERSAL_ROUTER,
  encodeFunctionData({
    abi: parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]),
    functionName: "execute",
    args: ["0x10", [v4Input], block.timestamp + 600n],
  }),
);
const zoraAfter = await pub.readContract({ address: ZORA, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
await test.stopImpersonatingAccount({ address: holder });

// Let the dump become "finalized" on anvil (finalized = latest - 64).
await test.mine({ blocks: 70 });
console.log(`dump tx ${hash}; received ${Number(zoraAfter - zoraBefore) / 1e18} ZORA; mined 70 blocks`);
