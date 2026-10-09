// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {NoriRead} from "../NoriRead.sol";
import {INoriTempoTokenBridge} from "../interfaces/INoriTempoTokenBridge.sol";

/// @notice Exposes NoriRead's functions to the tests, with the batch passed
///         in as a consumer passes the one it loaded.
contract NoriReadHarness {
    function verifySnapshotResult(
        INoriTempoTokenBridge noriBridge,
        INoriTempoTokenBridge.ProofRequestRootEntry calldata batch,
        address noriSnapshot,
        bytes32 queryId,
        NoriRead.SnapshotResultWitness calldata witness
    ) external pure returns (NoriRead.ProvenResult memory) {
        return NoriRead.verifySnapshotResult(noriBridge, batch, noriSnapshot, queryId, witness);
    }

    function loadProofQueueBatch(
        INoriTempoTokenBridge noriBridge,
        uint64 proofQueueBatchIndex
    ) external view returns (INoriTempoTokenBridge.ProofRequestRootEntry memory) {
        return NoriRead.loadProofQueueBatch(noriBridge, proofQueueBatchIndex);
    }

    function loadNoriProofQueue(INoriTempoTokenBridge noriBridge) external view returns (address) {
        return NoriRead.loadNoriProofQueue(noriBridge);
    }

    function queryIdOf(address target, bytes calldata data) external pure returns (bytes32) {
        return NoriRead.queryIdOf(target, data);
    }

    function resultBool(NoriRead.ProvenResult calldata proven) external pure returns (bool isBool, bool value) {
        return NoriRead.resultBool(proven);
    }
}
