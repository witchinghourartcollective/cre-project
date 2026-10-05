# coin-breaker: test results

A Chainlink CRE workflow that watches Witching Hour's Zora coins on Base and pauses
automated buying when a pool behaves abnormally.

- **Trigger:** cron, every 5 minutes
- **Reads:** Uniswap v4 StateView `0xa3c0c9b65bad0b08107aa264b0f3db444b867a71` on Base. Each coin's
  price and in-range liquidity at the finalized block, compared with 1800 blocks (~1 hour) earlier.
- **Trips on:** ≥15% price drop, ≥30% spike, ≥50% liquidity drop, or zero liquidity
  (about 3× the worst hourly move in 39 days of history: −5.1% / +9%)
- **Writes:** a signed CRE report to `CoinCircuitBreaker` on Base
  (`0xBFeDCca4dE6cF908C1cf375D430DaDDc15C9bdca`, forwarder `0xF8344CFd5c43616a4366C34E3EEE75af79a74482`)
- **Consumer:** the whm-flywheel accumulator checks `isPaused(coin)` before every buy (fails closed)

## 1. Live Base mainnet, read-only (2026-10-02)
```
Comparing finalized block 52063080 vs 52061280 (1800 blocks back)
witchinghour: price 0 bps, liquidity 0 bps -> OK
witchinghourmusic: price 0 bps, liquidity 0 bps -> OK
local-simulation: 0 coin(s) would trip; no report built, nothing written
```
Workflow prices matched the Zora API's USD price within 0.3%.

## 2. Anvil fork of Base: realistic dump (whole flywheel bag sold)
```
witchinghour: price -81 bps, liquidity 143 bps -> OK
witchinghourmusic: price -399 bps, liquidity 0 bps -> OK
```
The pools are deeper than daily volume ($0.15–$0.38) suggests, and normal selling doesn't trip it.

## 3. Anvil fork of Base: crash (~2.4M witchinghourmusic sold within the hour)
```
witchinghourmusic: price -2489 bps, liquidity -7076 bps -> LIQUIDITY_DROP
local-simulation: 1 coin(s) would trip; no report built, nothing written
```

## 4. End-to-end on the fork
Deployed `CoinCircuitBreaker` → delivered a pause report → whm-flywheel's `createPauseCheck`
returned `true` for witchinghourmusic, `false` for witchinghour.

## Tests
- Workflow: 11 unit tests (pool id, price math both sides, bps, thresholds at the boundaries, config fail-closed)
- Flywheel: 13 tests incl. "paused coins are never quoted or bought" and "a failed breaker read fails closed"

## Found along the way (template feedback for Chainlink)
- `bring-your-own-data-ts` NAV: `api.m0.xyz` no longer resolves. Chainlink's own M0 external adapter
  already uses `https://mnav.m0.xyz/api/rpc`.
- Same workflow computes NAV with JS floats (`3208070.0437240005`); it should use scaled integers.
- `prediction-market-ts` dispute workflow reads at the finalized block, so a fresh DisputeRaised needs 64+
  blocks before the status reads as Disputed (worth a README note).
