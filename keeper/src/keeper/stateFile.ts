import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * A JSON state file as it is now: read afresh each time, so what another
 * process added is seen. A missing file or field reads as in `empty`.
 *
 * @param path The file.
 * @param empty The state with nothing in it.
 * @returns The state.
 */
export function loadStateFile<TState extends object>(path: string, empty: TState): TState {
    return {
        ...empty,
        ...(existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Partial<TState>) : {}),
    };
}

/**
 * Applies `change` to a JSON state file as it is now, so what another
 * process added is kept.
 *
 * @param path The file.
 * @param empty The state with nothing in it.
 * @param change The change.
 */
export function updateStateFile<TState extends object>(path: string, empty: TState, change: (state: TState) => TState) {
    writeFileSync(path, JSON.stringify(change(loadStateFile(path, empty)), null, 2) + '\n');
}
