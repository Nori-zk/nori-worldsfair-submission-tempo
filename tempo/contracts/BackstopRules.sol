// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {INoriTempoTokenBridge} from "./interfaces/INoriTempoTokenBridge.sol";
import {IGuardedToken} from "./interfaces/IGuardedToken.sol";

/// @title BackstopRules
/// @notice A guard's state and its rules: supply checkpoints, the windowed
///         supply a proven backing is compared with, the trip latch and the
///         status. Free of the contract's entry points, so they test alone.
library BackstopRules {
    /// @notice Supply checkpoints kept per guard: an hour at one a minute.
    uint256 internal constant CHECKPOINTS = 64;

    /// @notice A guard's settings, fixed at creation.
    struct GuardConfig {
        /// The Nori bridge whose committed proof queue batches the guard reads.
        INoriTempoTokenBridge noriBridge;
        /// The NoriSnapshot contract on Ethereum.
        address noriSnapshot;
        /// Query whose result is the backing, e.g. `balanceOf(lockbox)`.
        bytes32 backingQuery;
        /// Query whose result is the source pause flag; zero for none.
        bytes32 pauseQuery;
        /// Decimals of the backing result.
        uint8 backingDecimals;
        /// Supply allowed above backing, in token units.
        uint64 tolerance;
        /// A backing read at Ethereum time T is compared with the lowest
        /// supply checkpoint in [T - window, T + window], given one in
        /// [T - window, T - skew].
        uint32 windowSecs;
        uint32 skewSecs;
        uint32 checkpointIntervalSecs;
        /// Backing older than this is STALE.
        uint32 maxStalenessSecs;
    }

    struct Checkpoint {
        uint64 time;
        uint64 supply;
    }

    struct Guard {
        address admin;
        IGuardedToken token;
        GuardConfig config;
        /// The Ethereum queue the Nori bridge proves, read at creation.
        address ethProofQueue;
        /// Latest proven backing, in token units.
        uint64 backing;
        uint64 backingEthBlock;
        uint64 backingEthTime;
        bool paused;
        uint64 pauseEthBlock;
        /// Latched until the admin unlatches.
        bool tripped;
        uint64 tripEthBlock;
        uint64 tripDeficit;
        Checkpoint[CHECKPOINTS] checkpoints;
        /// Checkpoints written so far; the next goes at `count % CHECKPOINTS`.
        uint64 checkpointCount;
    }

    enum Status {
        Healthy,
        /// Live supply is above proven backing: normal for transfers in flight.
        Warn,
        /// No backing proven within `maxStalenessSecs`.
        Stale,
        PausedAtSource,
        /// Supply exceeded proven backing in a finalized window. Latched.
        Tripped
    }

    /// @notice Converts a result with `from` decimals to token units with `to`
    ///         decimals, rounding down and saturating at `type(uint64).max`.
    function toTokenUnits(uint256 value, uint8 from, uint8 to) internal pure returns (uint64) {
        uint256 scaled;
        if (from >= to) {
            scaled = value / 10 ** (from - to);
        } else {
            uint256 factor = 10 ** (to - from);
            scaled = value > type(uint256).max / factor ? type(uint256).max : value * factor;
        }
        return scaled > type(uint64).max ? type(uint64).max : uint64(scaled);
    }

    function checkpointDue(Guard storage guard, uint64 now_) internal view returns (bool) {
        if (guard.checkpointCount == 0) return true;
        Checkpoint storage last = guard.checkpoints[(guard.checkpointCount - 1) % CHECKPOINTS];
        return int256(uint256(now_)) - int256(uint256(last.time)) >= int256(uint256(guard.config.checkpointIntervalSecs));
    }

    function pushCheckpoint(Guard storage guard, uint64 time, uint64 supply) internal {
        guard.checkpoints[guard.checkpointCount % CHECKPOINTS] = Checkpoint({time: time, supply: supply});
        guard.checkpointCount += 1;
    }

    /// @notice The lowest supply checkpointed in `[ethTime - window, ethTime + window]`,
    ///         if one falls in `[ethTime - window, ethTime - skew]`.
    /// @dev A Tempo mint needs an Ethereum lock before it, so supply up to the
    ///      backing's own time can only count tokens that backing covers. The
    ///      minimum absorbs burns whose unlock lands before `ethTime`,
    ///      including a burn just before it, which only a later checkpoint
    ///      sees. Later checkpoints can only lower the minimum; the one before
    ///      `ethTime - skew` keeps a verdict from resting on supply minted
    ///      after the backing.
    /// @return found Whether a checkpoint falls before `ethTime - skew` in the window.
    /// @return minSupply The lowest supply in the window, when found.
    function windowMinSupply(Guard storage guard, uint64 ethTime) internal view returns (bool found, uint64 minSupply) {
        int256 time = int256(uint256(ethTime));
        int256 window = int256(uint256(guard.config.windowSecs));
        int256 before = time - int256(uint256(guard.config.skewSecs));
        uint256 written = guard.checkpointCount < CHECKPOINTS ? guard.checkpointCount : CHECKPOINTS;
        bool anyBefore = false;
        minSupply = type(uint64).max;
        for (uint256 i = 0; i < written; i++) {
            Checkpoint storage checkpoint = guard.checkpoints[i];
            int256 at = int256(uint256(checkpoint.time));
            if (at < time - window || at > time + window) continue;
            if (at <= before) anyBefore = true;
            if (checkpoint.supply < minSupply) minSupply = checkpoint.supply;
        }
        if (!anyBefore) return (false, 0);
        return (true, minSupply);
    }

    /// @notice Records a newer proven backing and trips (latched) when
    ///         windowed supply exceeds it. No checkpoint in the window means no
    ///         verdict.
    /// @return deficit How far windowed supply exceeds backing plus
    ///         tolerance; zero for none.
    function applyBacking(Guard storage guard, uint64 backing, uint64 ethBlock, uint64 ethTime) internal returns (uint64 deficit) {
        guard.backing = backing;
        guard.backingEthBlock = ethBlock;
        guard.backingEthTime = ethTime;

        (bool found, uint64 supply) = windowMinSupply(guard, ethTime);
        if (!found) return 0;
        uint256 allowed = uint256(backing) + guard.config.tolerance;
        if (supply <= allowed) return 0;
        deficit = uint64(supply - allowed);
        if (!guard.tripped) {
            guard.tripped = true;
            guard.tripEthBlock = ethBlock;
            guard.tripDeficit = deficit;
        }
    }

    function status(Guard storage guard, uint256 liveSupply, uint64 now_) internal view returns (Status) {
        if (guard.tripped) return Status.Tripped;
        if (guard.paused) return Status.PausedAtSource;
        if (
            guard.backingEthTime == 0 ||
            int256(uint256(now_)) - int256(uint256(guard.backingEthTime)) > int256(uint256(guard.config.maxStalenessSecs))
        ) return Status.Stale;
        if (liveSupply > uint256(guard.backing) + guard.config.tolerance) return Status.Warn;
        return Status.Healthy;
    }
}
