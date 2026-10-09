// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BackstopRules} from "./BackstopRules.sol";
import {NoriRead} from "./NoriRead.sol";
import {INoriTempoTokenBridge} from "./interfaces/INoriTempoTokenBridge.sol";
import {IGuardedToken} from "./interfaces/IGuardedToken.sol";

/// @title Backstop
/// @notice A circuit breaker for a bridged asset. A guard compares the asset's
///         Ethereum backing, proven through Nori, with its Tempo supply.
/// @dev
///      - `checkpoint` (anyone, about once a minute) records the token's supply.
///      - `submitRead` (anyone) applies a proven backing or pause flag. If
///        supply checkpointed before the backing's Ethereum time exceeds it,
///        the guard trips and stays tripped until the admin calls `unlatch`.
///      - Consumers call `assertHealthy` (reverts unless HEALTHY) or `status`.
contract Backstop {
    using BackstopRules for BackstopRules.Guard;

    enum ReadKind {
        Backing,
        Pause
    }

    /// @notice Each guard, by `guardIdOf(token, admin)`.
    mapping(bytes32 => BackstopRules.Guard) internal _guards;

    event GuardCreated(bytes32 indexed guardId, address indexed token, address indexed admin, address ethProofQueue);
    event BackingRead(bytes32 indexed guardId, uint64 backing, uint64 ethBlock, uint64 ethTime, uint64 deficit, bool tripped);
    event PauseRead(bytes32 indexed guardId, bool paused, uint64 ethBlock);
    event Unlatched(bytes32 indexed guardId);

    /// @notice Invalid guard config.
    error InvalidConfig();
    /// @notice A guard for this token and admin exists.
    error GuardExists(bytes32 guardId);
    /// @notice No guard has this id.
    error NoGuard(bytes32 guardId);
    /// @notice Only the guard's admin may do this.
    error NotAdmin(address caller, address admin);
    /// @notice This guard has no pause query.
    error NoPauseQuery();
    /// @notice A newer result was already applied.
    error ReadNotNewer(uint64 ethBlock, uint64 appliedEthBlock);
    /// @notice Too soon for another checkpoint.
    error CheckpointTooSoon();
    /// @notice Supply is above proven backing.
    error SupplyAboveBacking();
    /// @notice No recent proven backing.
    error Stale();
    /// @notice Paused on Ethereum.
    error PausedAtSource();
    /// @notice Tripped: supply exceeded proven backing.
    error Tripped();
    /// @notice The pause query's result is not a bool.
    error PauseResultNotBool();

    /// @notice A guard's id: one per token and admin, as its config is fixed
    ///         at creation; a new config needs another admin.
    function guardIdOf(address token, address admin) public pure returns (bytes32) {
        return keccak256(abi.encode(token, admin));
    }

    /// @notice Creates a guard for `token`, owned by the caller. Reads the
    ///         Ethereum queue the Nori bridge proves, so anyone can check it is
    ///         NoriSnapshot's.
    /// @return guardId The new guard's id.
    function createGuard(IGuardedToken token, BackstopRules.GuardConfig calldata config) external returns (bytes32 guardId) {
        if (
            config.windowSecs <= config.skewSecs ||
            config.checkpointIntervalSecs == 0 ||
            config.maxStalenessSecs == 0 ||
            address(config.noriBridge) == address(0)
        ) revert InvalidConfig();
        guardId = guardIdOf(address(token), msg.sender);
        BackstopRules.Guard storage guard_ = _guards[guardId];
        if (guard_.admin != address(0)) revert GuardExists(guardId);

        address ethProofQueue = NoriRead.loadNoriProofQueue(config.noriBridge);
        guard_.admin = msg.sender;
        guard_.token = token;
        guard_.config = config;
        guard_.ethProofQueue = ethProofQueue;
        guard_.pushCheckpoint(uint64(block.timestamp), _supply(token));

        emit GuardCreated(guardId, address(token), msg.sender, ethProofQueue);
    }

    /// @notice Records the token's supply, at most once per `checkpointIntervalSecs`.
    function checkpoint(bytes32 guardId) external {
        BackstopRules.Guard storage guard_ = _guard(guardId);
        uint64 now_ = uint64(block.timestamp);
        if (!guard_.checkpointDue(now_)) revert CheckpointTooSoon();
        guard_.pushCheckpoint(now_, _supply(guard_.token));
    }

    /// @notice Applies a proven NoriSnapshot result: the backing or the pause
    ///         flag. Each must be from a newer Ethereum block than the last one
    ///         applied.
    /// @param proofQueueBatchIndex The committed batch, on the guard's Nori
    ///        bridge, holding the snapshot.
    function submitRead(
        bytes32 guardId,
        ReadKind kind,
        uint64 proofQueueBatchIndex,
        NoriRead.SnapshotResultWitness calldata witness
    ) external {
        BackstopRules.Guard storage guard_ = _guard(guardId);
        BackstopRules.GuardConfig storage config = guard_.config;
        INoriTempoTokenBridge.ProofRequestRootEntry memory batch = NoriRead.loadProofQueueBatch(
            config.noriBridge,
            proofQueueBatchIndex
        );
        bytes32 query;
        if (kind == ReadKind.Backing) query = config.backingQuery;
        else if (config.pauseQuery != bytes32(0)) query = config.pauseQuery;
        else revert NoPauseQuery();
        NoriRead.ProvenResult memory proven = NoriRead.verifySnapshotResult(
            config.noriBridge,
            batch,
            config.noriSnapshot,
            query,
            witness
        );

        if (kind == ReadKind.Backing) {
            if (proven.ethBlockNumber <= guard_.backingEthBlock)
                revert ReadNotNewer(proven.ethBlockNumber, guard_.backingEthBlock);
            uint64 backing = BackstopRules.toTokenUnits(
                uint256(proven.result),
                config.backingDecimals,
                guard_.token.decimals()
            );
            uint64 deficit = guard_.applyBacking(backing, proven.ethBlockNumber, proven.ethTimestamp);
            emit BackingRead(guardId, backing, proven.ethBlockNumber, proven.ethTimestamp, deficit, guard_.tripped);
        } else {
            if (proven.ethBlockNumber <= guard_.pauseEthBlock)
                revert ReadNotNewer(proven.ethBlockNumber, guard_.pauseEthBlock);
            // An ABI bool is 0 or 1; anything else means the pause query is
            // misconfigured, and must not latch PAUSED_AT_SOURCE
            (bool isBool, bool paused) = NoriRead.resultBool(proven);
            if (!isBool) revert PauseResultNotBool();
            guard_.paused = paused;
            guard_.pauseEthBlock = proven.ethBlockNumber;
            emit PauseRead(guardId, paused, proven.ethBlockNumber);
        }
    }

    /// @notice The guard's status.
    function status(bytes32 guardId) public view returns (BackstopRules.Status) {
        BackstopRules.Guard storage guard_ = _guard(guardId);
        return guard_.status(guard_.token.totalSupply(), uint64(block.timestamp));
    }

    /// @notice Reverts unless the guard is HEALTHY. A view, so consumers call
    ///         it on every deposit.
    function assertHealthy(bytes32 guardId) external view {
        BackstopRules.Status current = status(guardId);
        if (current == BackstopRules.Status.Warn) revert SupplyAboveBacking();
        if (current == BackstopRules.Status.Stale) revert Stale();
        if (current == BackstopRules.Status.PausedAtSource) revert PausedAtSource();
        if (current == BackstopRules.Status.Tripped) revert Tripped();
    }

    /// @notice Clears a trip. Admin only.
    function unlatch(bytes32 guardId) external {
        BackstopRules.Guard storage guard_ = _guard(guardId);
        if (msg.sender != guard_.admin) revert NotAdmin(msg.sender, guard_.admin);
        guard_.tripped = false;
        guard_.tripEthBlock = 0;
        guard_.tripDeficit = 0;
        emit Unlatched(guardId);
    }

    /// @notice The whole guard: its admin, token, config, proven backing and
    ///         pause flag, trip latch and supply checkpoints.
    function guard(bytes32 guardId) external view returns (BackstopRules.Guard memory) {
        return _guard(guardId);
    }

    function _guard(bytes32 guardId) internal view returns (BackstopRules.Guard storage guard_) {
        guard_ = _guards[guardId];
        if (guard_.admin == address(0)) revert NoGuard(guardId);
    }

    /// @dev The token's supply, saturating at `type(uint64).max` as checkpoints hold it.
    function _supply(IGuardedToken token) internal view returns (uint64) {
        uint256 supply = token.totalSupply();
        return supply > type(uint64).max ? type(uint64).max : uint64(supply);
    }
}
