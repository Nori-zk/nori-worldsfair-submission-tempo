export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Rejects once `ms` pass; the work itself is left to finish or fail on its own. */
export function withTimeout<T>(
    work: Promise<T>,
    ms: number,
    what: string
): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`${what} timed out after ${ms / 1000} s`)),
            ms
        );
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
