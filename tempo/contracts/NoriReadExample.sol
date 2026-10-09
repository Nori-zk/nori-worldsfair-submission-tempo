// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {NoriRead} from "./NoriRead.sol";
import {INoriTempoTokenBridge} from "./interfaces/INoriTempoTokenBridge.sol";

/// @title NoriReadExample
/// @notice The smallest consumer of NoriRead: verifies one NoriSnapshot result
///         against a proof queue batch committed by the Nori bridge, and emits it.
/// @dev A real consumer pins the NoriSnapshot address and the query ids it
///      acts on in its own configuration, and checks the result's age; this
///      example takes both from the caller so one deployment can read any
///      snapshot. The Nori bridge it trusts is pinned at deploy.
contract NoriReadExample {
    /// @notice The Nori bridge whose committed batches this contract trusts.
    INoriTempoTokenBridge public immutable noriBridge;

    /// @notice A result proven against Ethereum state; see `NoriRead.ProvenResult`.
    event SnapshotResultRead(
        bytes32 queryId,
        bytes32 result,
        uint64 snapshotIndex,
        uint64 requestId,
        uint64 ethBlockNumber,
        uint64 ethTimestamp,
        uint64 provenBlockNumber
    );

    constructor(INoriTempoTokenBridge noriBridge_) {
        noriBridge = noriBridge_;
    }

    /// @notice Verify `witness` proves `queryId`'s result in a snapshot taken
    ///         by `noriSnapshot`, against the committed batch at
    ///         `proofQueueBatchIndex`, and emit the result.
    function readSnapshotResult(
        address noriSnapshot,
        bytes32 queryId,
        uint64 proofQueueBatchIndex,
        NoriRead.SnapshotResultWitness calldata witness
    ) external {
        INoriTempoTokenBridge.ProofRequestRootEntry memory batch = NoriRead.loadProofQueueBatch(
            noriBridge,
            proofQueueBatchIndex
        );
        NoriRead.ProvenResult memory proven = NoriRead.verifySnapshotResult(
            noriBridge,
            batch,
            noriSnapshot,
            queryId,
            witness
        );
        emit SnapshotResultRead(
            proven.queryId,
            proven.result,
            proven.snapshotIndex,
            proven.requestId,
            proven.ethBlockNumber,
            proven.ethTimestamp,
            proven.provenBlockNumber
        );
    }
}
