// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BackstopRules} from "../BackstopRules.sol";

/// @notice Holds one guard and exposes the Backstop rules on it, with the
///         times given rather than read from the block.
contract BackstopRulesHarness {
    using BackstopRules for BackstopRules.Guard;

    BackstopRules.Guard internal _guard;

    constructor(BackstopRules.GuardConfig memory config) {
        _guard.config = config;
    }

    function toTokenUnits(uint256 value, uint8 from, uint8 to) external pure returns (uint64) {
        return BackstopRules.toTokenUnits(value, from, to);
    }

    function checkpointDue(uint64 now_) external view returns (bool) {
        return _guard.checkpointDue(now_);
    }

    function pushCheckpoint(uint64 time, uint64 supply) external {
        _guard.pushCheckpoint(time, supply);
    }

    function pushCheckpoints(uint64 from, uint64 to, uint64 step, uint64[] calldata supplies) external {
        uint256 i = 0;
        for (uint64 time = from; time < to; time += step) _guard.pushCheckpoint(time, supplies[i++]);
    }

    function applyBacking(uint64 backing, uint64 ethBlock, uint64 ethTime) external returns (uint64 deficit) {
        return _guard.applyBacking(backing, ethBlock, ethTime);
    }

    function status(uint256 liveSupply, uint64 now_) external view returns (BackstopRules.Status) {
        return _guard.status(liveSupply, now_);
    }

    function setPaused(bool paused) external {
        _guard.paused = paused;
    }

    function setTripped(bool tripped) external {
        _guard.tripped = tripped;
    }

    function guard() external view returns (BackstopRules.Guard memory) {
        return _guard;
    }
}
