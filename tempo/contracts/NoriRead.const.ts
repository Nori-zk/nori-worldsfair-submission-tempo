/** Collection keys of every snapshot leaf: the index and the time key (`NoriRead.SNAPSHOT_COLLECTION_KEYS`). */
export const SNAPSHOT_COLLECTION_KEYS = 2;

/** The snapshot's own bounds, which `NoriRead` mirrors (`NoriRead.MAX_QUERIES`, `MAX_RESULT_PATH`, `RESULT_LEAF_PREFIX`, `SENTINEL`). */
export {
    MAX_QUERIES,
    MAX_RESULT_PATH,
    RESULT_LEAF_PREFIX,
    SENTINEL,
} from '@nori-zk/ethereum-snapshot';

/** The Nori bridge's bounds on a request witness, which `NoriRead` mirrors (`NoriRead.MAX_TREE_DEPTH`, `MAX_BATCH`, `MAX_COLLECTION_KEYS`). */
export {
    MAX_BATCH,
    MAX_COLLECTION_KEYS,
    MAX_TREE_DEPTH,
} from '@nori-zk/tempo-token-bridge';
