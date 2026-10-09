// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice What a consumer reads from the Nori light client on Tempo
///         (nori-tempo-sdk `NoriTempoTokenBridge`): its committed proof queue
///         batches, the Ethereum queue it proves, and its request witness
///         hashing. The structs are ABI-identical to the contract's.
interface INoriTempoTokenBridge {
    /// @notice One committed proof queue batch: the root of its requests'
    ///         tree, the Ethereum block its proof read the queue at, the
    ///         request ids `[inputQueueCursor, outputQueueCursor)` it holds,
    ///         and the Tempo block that committed it.
    struct ProofRequestRootEntry {
        bytes32 root;
        uint64 outputBlockNumber;
        uint64 inputQueueCursor;
        uint64 outputQueueCursor;
        uint64 tempoBlockNumber;
    }

    /// @notice One verified request, carrying everything its leaf is hashed from.
    struct VerifiedRequest {
        address target;
        uint8 collectionKeysCount;
        bytes32[2] collectionKeys;
        uint256 value;
    }

    /// @notice A request's Merkle witness in its proof queue batch: the
    ///         bottom-up sibling path, the request's index in the batch, and
    ///         the request.
    struct VerifiedRequestWitness {
        bytes32[] path;
        uint64 index;
        VerifiedRequest value;
    }

    /// @notice The Ethereum `NoriProofRequestQueue` every proof anchors on.
    function ethProofQueueAddress() external view returns (address);

    /// @notice The committed proof queue batch at `proofQueueBatchIndex`;
    ///         reverts `ProofQueueBatchNotCommitted` beyond the committed ones.
    function proofQueueBatch(uint64 proofQueueBatchIndex) external view returns (ProofRequestRootEntry memory);

    /// @notice The root a witness resolves to: its leaf hashed up the path.
    function verifiedRequestWitnessRoot(VerifiedRequestWitness calldata witness) external pure returns (bytes32);

    /// @notice A request's Merkle leaf.
    function requestLeafHash(VerifiedRequest calldata request) external pure returns (bytes32);
}
