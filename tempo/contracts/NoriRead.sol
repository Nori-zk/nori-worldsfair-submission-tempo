// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {INoriTempoTokenBridge} from "./interfaces/INoriTempoTokenBridge.sol";

/// @title NoriRead
/// @notice Verify a `NoriSnapshot` result on Tempo.
/// @dev A snapshot is one leaf in a proof queue batch that the Nori bridge
///      committed: `target` = NoriSnapshot, keys = `[index, block << 64 | time]`,
///      value = `resultsRoot | 1 << 255`. `verifySnapshotResult` checks the
///      leaf against the batch root, then `sha256(0x00 ++ queryId ++ result)`
///      against the results root.
///
///      The consumer pins the Nori bridge (`loadProofQueueBatch` reads only
///      its committed batches, and `loadNoriProofQueue` must equal
///      `NoriSnapshot.proofQueue()`), the NoriSnapshot address and its query
///      ids. It also checks freshness, and keeps the newest `ethBlockNumber`
///      per query, because old snapshots stay valid.
library NoriRead {
    /// @notice Most queries in one snapshot (`NoriSnapshot.MAX_QUERIES`).
    uint256 internal constant MAX_QUERIES = 256;
    /// @notice Longest results path: a tree over `MAX_QUERIES` leaves.
    uint256 internal constant MAX_RESULT_PATH = 8;
    /// @notice Collection keys of every snapshot leaf: the index and the time key.
    uint8 internal constant SNAPSHOT_COLLECTION_KEYS = 2;
    /// @notice Prefixed to every results leaf (`NoriSnapshot.RESULT_LEAF_PREFIX`).
    bytes1 internal constant RESULT_LEAF_PREFIX = 0x00;
    /// @notice The top bit of a committed word.
    uint256 internal constant SENTINEL = 1 << 255;
    /// @notice The bridge's bounds on a request witness: tree depth, batch size, collection keys.
    uint256 internal constant MAX_TREE_DEPTH = 16;
    uint256 internal constant MAX_BATCH = 1 << MAX_TREE_DEPTH;
    uint8 internal constant MAX_COLLECTION_KEYS = 2;

    /// @notice Everything needed to check one snapshot result, besides the
    ///         query id the consumer pins.
    struct SnapshotResultWitness {
        /// The snapshot's proof request leaf, its index in the proof queue
        /// batch and its path to the batch root.
        INoriTempoTokenBridge.VerifiedRequestWitness request;
        /// The query's 32-byte result, as the view call returned it.
        bytes32 result;
        /// The result's index among the snapshot's queries.
        uint16 resultIndex;
        /// Sibling hashes from the result leaf up to the results root, bottom-up.
        bytes32[] resultPath;
    }

    /// @notice A result proven against Ethereum state.
    struct ProvenResult {
        /// `keccak256(abi.encode(target, data))` of the query.
        bytes32 queryId;
        /// The 32-byte result.
        bytes32 result;
        /// `NoriSnapshot`'s index for the snapshot, from 1.
        uint64 snapshotIndex;
        /// The proof request queue id of the snapshot's commitment; unique, as
        /// it comes from the batch's cursors.
        uint64 requestId;
        /// The Ethereum block the view call ran in.
        uint64 ethBlockNumber;
        /// That block's timestamp, in seconds.
        uint64 ethTimestamp;
        /// The finalized block whose state the batch proved (at or after
        /// `ethBlockNumber`; the commitment is write-once, so it is unchanged).
        uint64 provenBlockNumber;
    }

    /// @notice The request witness is malformed (path too long, index or
    ///         collection key count out of range).
    error RequestWitness();
    /// @notice The request leaf's path does not reach the batch root.
    error BatchRootMismatch();
    /// @notice The request index is outside the batch's cursor range.
    error RequestIndexOutsideBatch(uint64 index, uint64 batchSize);
    /// @notice The leaf's target is not the `NoriSnapshot` the consumer trusts.
    error NotNoriSnapshot(address target);
    /// @notice The leaf does not carry the two snapshot collection keys.
    error CollectionKeysCount(uint8 count);
    /// @notice The proven word lacks the top bit, so it is not a snapshot
    ///         commitment (for example a false zero from an exclusion proof).
    error MissingSentinel();
    /// @notice The result index does not fit the results path.
    error ResultIndex(uint16 index, uint256 pathLength);
    /// @notice The results path is longer than `MAX_RESULT_PATH`.
    error ResultPathTooLong(uint256 length);
    /// @notice The result's path does not reach the committed results root.
    error ResultRootMismatch();
    /// @notice The snapshot index is zero or does not fit a `uint64`.
    ///         NoriSnapshot numbers snapshots from 1, so a zero index is a key
    ///         the proving side read as zero, not a snapshot.
    error SnapshotIndex();
    /// @notice The time key is zero or wider than 128 bits, which
    ///         NoriSnapshot never writes.
    error TimeKey();

    /// @notice Reads a committed proof queue batch from the Nori bridge the
    ///         consumer trusts. Only its `update` commits batches, each holding
    ///         one batch root; an index beyond them reverts in the bridge
    ///         (`ProofQueueBatchNotCommitted`).
    function loadProofQueueBatch(
        INoriTempoTokenBridge noriBridge,
        uint64 proofQueueBatchIndex
    ) internal view returns (INoriTempoTokenBridge.ProofRequestRootEntry memory) {
        return noriBridge.proofQueueBatch(proofQueueBatchIndex);
    }

    /// @notice Reads the Ethereum proof request queue the Nori bridge proves.
    ///         A consumer checks it equals `NoriSnapshot.proofQueue()` once,
    ///         when it pins the two.
    function loadNoriProofQueue(INoriTempoTokenBridge noriBridge) internal view returns (address) {
        return noriBridge.ethProofQueueAddress();
    }

    /// @notice Verifies one `NoriSnapshot` result against a committed proof queue batch.
    /// @param noriBridge The Nori bridge the batch was read from, whose witness
    ///        hashing checks the request leaf.
    /// @param batch The batch, from `loadProofQueueBatch` on the bridge the consumer trusts.
    /// @param noriSnapshot The `NoriSnapshot` address the consumer trusts.
    /// @param queryId The query the consumer wants. The result leaf is hashed
    ///        from it, so only a result committed for this query verifies.
    /// @param witness The request leaf with its batch path, and the result
    ///        with its results path.
    /// @return proven The result with the snapshot's index, block and time; the
    ///         caller decides whether that time is fresh enough.
    function verifySnapshotResult(
        INoriTempoTokenBridge noriBridge,
        INoriTempoTokenBridge.ProofRequestRootEntry memory batch,
        address noriSnapshot,
        bytes32 queryId,
        SnapshotResultWitness calldata witness
    ) internal pure returns (ProvenResult memory proven) {
        INoriTempoTokenBridge.VerifiedRequestWitness calldata request = witness.request;

        // 1. The request leaf is in the committed batch
        if (
            request.index >= MAX_BATCH ||
            request.path.length > MAX_TREE_DEPTH ||
            request.value.collectionKeysCount > MAX_COLLECTION_KEYS
        ) revert RequestWitness();
        if (noriBridge.verifiedRequestWitnessRoot(request) != batch.root) revert BatchRootMismatch();
        uint64 batchSize = batch.outputQueueCursor > batch.inputQueueCursor
            ? batch.outputQueueCursor - batch.inputQueueCursor
            : 0;
        if (request.index >= batchSize) revert RequestIndexOutsideBatch(request.index, batchSize);

        // 2. The leaf is a NoriSnapshot commitment
        INoriTempoTokenBridge.VerifiedRequest calldata leaf = request.value;
        if (leaf.target != noriSnapshot) revert NotNoriSnapshot(leaf.target);
        if (leaf.collectionKeysCount != SNAPSHOT_COLLECTION_KEYS) revert CollectionKeysCount(leaf.collectionKeysCount);
        uint256 committed = leaf.value;
        if (committed & SENTINEL == 0) revert MissingSentinel();

        // 3. The result is in the snapshot's results tree
        uint256 pathLength = witness.resultPath.length;
        if (pathLength > MAX_RESULT_PATH) revert ResultPathTooLong(pathLength);
        uint256 resultIndex = witness.resultIndex;
        if (resultIndex >= MAX_QUERIES || resultIndex >> pathLength != 0)
            revert ResultIndex(witness.resultIndex, pathLength);
        bytes32 node = sha256(abi.encodePacked(RESULT_LEAF_PREFIX, queryId, witness.result));
        for (uint256 level = 0; level < pathLength; level++) {
            bytes32 sibling = witness.resultPath[level];
            node = (resultIndex >> level) & 1 == 1
                ? sha256(abi.encodePacked(sibling, node))
                : sha256(abi.encodePacked(node, sibling));
        }
        if (uint256(node) | SENTINEL != committed) revert ResultRootMismatch();

        // 4. The snapshot's index and time, from its collection keys. Neither
        //    is ever zero, so a key the proving side read as zero (a false
        //    zero, as for the sentinel) is rejected rather than misreported.
        uint256 indexKey = uint256(leaf.collectionKeys[0]);
        if (indexKey >> 64 != 0 || indexKey == 0) revert SnapshotIndex();
        uint256 timeKey = uint256(leaf.collectionKeys[1]);
        if (timeKey >> 128 != 0 || timeKey == 0) revert TimeKey();

        proven = ProvenResult({
            queryId: queryId,
            result: witness.result,
            snapshotIndex: uint64(indexKey),
            requestId: batch.inputQueueCursor + request.index,
            ethBlockNumber: uint64(timeKey >> 64),
            ethTimestamp: uint64(timeKey),
            provenBlockNumber: batch.outputBlockNumber
        });
    }

    /// @notice `NoriSnapshot.queryIdOf`: `keccak256(abi.encode(target, data))`.
    function queryIdOf(address target, bytes memory data) internal pure returns (bytes32) {
        return keccak256(abi.encode(target, data));
    }

    /// @notice The result as a `bool`, if it is an ABI-encoded `bool` (0 or 1).
    /// @return isBool Whether the result is 0 or 1.
    /// @return value The `bool`, when it is one.
    function resultBool(ProvenResult memory proven) internal pure returns (bool isBool, bool value) {
        uint256 word = uint256(proven.result);
        return (word <= 1, word == 1);
    }
}
