import { GUARD_STATUS_NAMES } from '@nori-zk/tempo-backstop';

/** A guard's settings (`BackstopRules.GuardConfig`), as `Backstop.createGuard` takes them. */
export interface GuardConfig {
    /** The `NoriTempoTokenBridge` whose committed batches the guard trusts. */
    noriBridge: string;
    /** 20-byte Ethereum address, 0x-hex. */
    noriSnapshot: string;
    /** Query ids, 0x-hex; a zero pause query means none. */
    backingQuery: string;
    pauseQuery: string;
    backingDecimals: number;
    tolerance: bigint;
    windowSecs: number;
    skewSecs: number;
    checkpointIntervalSecs: number;
    maxStalenessSecs: number;
}

/** The name of a status `Backstop.status` returns. */
export function guardStatusName(status: bigint): string {
    return GUARD_STATUS_NAMES[Number(status)] ?? `UNKNOWN_STATUS_${status}`;
}
