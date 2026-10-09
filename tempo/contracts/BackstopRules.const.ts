/** Supply checkpoints a guard keeps (`BackstopRules.CHECKPOINTS`): an hour at one a minute. */
export const CHECKPOINTS = 64;

/** A guard's status (`BackstopRules.Status`), as `Backstop.status` returns it. */
export const GuardStatus = {
    Healthy: 0n,
    Warn: 1n,
    Stale: 2n,
    PausedAtSource: 3n,
    Tripped: 4n,
} as const;
export type GuardStatus = (typeof GuardStatus)[keyof typeof GuardStatus];

/** `GuardStatus`'s names, by value, as the keeper and dashboards show them. */
export const GUARD_STATUS_NAMES = [
    'HEALTHY',
    'WARN',
    'STALE',
    'PAUSED_AT_SOURCE',
    'TRIPPED',
] as const;
