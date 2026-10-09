/** Which proven result `Backstop.submitRead` applies (`Backstop.ReadKind`). */
export const ReadKind = { Backing: 0, Pause: 1 } as const;
export type ReadKind = (typeof ReadKind)[keyof typeof ReadKind];
