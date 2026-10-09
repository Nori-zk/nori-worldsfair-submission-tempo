/** Set on every committed word in place of the results root's top bit (`NoriSnapshot.SENTINEL`). */
export const SENTINEL = 1n << 255n;

/** Storage index of `NoriSnapshot.commitments` (`NoriSnapshot.COMMITMENTS_SLOT_INDEX`). */
export const COMMITMENTS_SLOT_INDEX = 0n;

/** Storage index of `NoriSnapshot.snapshotCount`, right after the commitments. */
export const SNAPSHOT_COUNT_SLOT_INDEX = 1n;

/** Most queries in one snapshot (`NoriSnapshot.MAX_QUERIES`). */
export const MAX_QUERIES = 256;

/** Longest results path: a tree over `MAX_QUERIES` leaves. */
export const MAX_RESULT_PATH = Math.log2(MAX_QUERIES);

/** Prefixed to every results leaf so it can never pass for a node (`NoriSnapshot.RESULT_LEAF_PREFIX`). */
export const RESULT_LEAF_PREFIX = '0x00';
