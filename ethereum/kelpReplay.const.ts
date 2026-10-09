/**
 * Where the Kelp replay vectors' timeline starts: 2030-01-01T00:00:00Z, after
 * any test run, so a node can time-travel to it. Its snapshots are at +60 s,
 * +600 s, +1,800 s and +3,000 s.
 */
export const KELP_REPLAY_START = Date.parse('2030-01-01T00:00:00Z') / 1000;
