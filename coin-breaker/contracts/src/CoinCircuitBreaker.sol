// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ReceiverTemplate} from "./ReceiverTemplate.sol";

/// @title CoinCircuitBreaker
/// @notice Receives signed CRE reports from the coin-breaker workflow and pauses buying of
///         individual coins. The flywheel calls `isPaused(coin)` before every buy.
///         Only the owner can unpause; the workflow can only pause.
/// @dev Report = abi.encode((address coin,uint8 reason,uint256 priceE18,uint256 observedAt)[]).
///      Reason codes mirror breaker.ts: 1 PRICE_DROP, 2 PRICE_SPIKE, 3 LIQUIDITY_DROP, 4 NO_LIQUIDITY.
contract CoinCircuitBreaker is ReceiverTemplate {
    struct Trip {
        address coin;
        uint8 reason;
        uint256 priceE18;
        uint256 observedAt;
    }

    struct State {
        bool paused;
        uint8 reason;
        uint256 priceE18;
        uint256 observedAt;
    }

    /// @notice Reports older than this are rejected as stale.
    uint256 public constant MAX_REPORT_AGE = 30 minutes;

    mapping(address => State) public stateOf;

    event CoinPaused(address indexed coin, uint8 reason, uint256 priceE18, uint256 observedAt);
    event CoinUnpaused(address indexed coin);

    error FutureTimestamp(uint256 observedAt);
    error StaleReport(uint256 observedAt);
    error UnknownReason(uint8 reason);

    constructor(address forwarder) ReceiverTemplate(forwarder) {}

    function isPaused(address coin) external view returns (bool) {
        return stateOf[coin].paused;
    }

    function unpause(address coin) external onlyOwner {
        delete stateOf[coin];
        emit CoinUnpaused(coin);
    }

    function _processReport(bytes calldata report) internal override {
        Trip[] memory trips = abi.decode(report, (Trip[]));
        for (uint256 i = 0; i < trips.length; i++) {
            Trip memory t = trips[i];
            if (t.reason == 0 || t.reason > 4) revert UnknownReason(t.reason);
            if (t.observedAt > block.timestamp) revert FutureTimestamp(t.observedAt);
            if (block.timestamp - t.observedAt > MAX_REPORT_AGE) revert StaleReport(t.observedAt);

            State storage s = stateOf[t.coin];
            // Ignore out-of-order reports for a coin that's already paused with newer data.
            if (s.paused && t.observedAt <= s.observedAt) continue;

            stateOf[t.coin] = State({paused: true, reason: t.reason, priceE18: t.priceE18, observedAt: t.observedAt});
            emit CoinPaused(t.coin, t.reason, t.priceE18, t.observedAt);
        }
    }
}
