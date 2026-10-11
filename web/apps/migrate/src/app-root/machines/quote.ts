/** What reading a lock request finds: the token, the holder's part of it, and the lock's fees. */
export interface Quote {
    /** The ERC-20's `symbol()`. */
    symbol: string;
    /** The ERC-20's `decimals()`. */
    decimals: number;
    /** The amount to lock, in the token's smallest unit. */
    units: bigint;
    /** The holder's balance of the token. */
    balance: bigint;
    /** What the holder lets the token bridge take: less than `units` asks for an approval first. */
    allowance: bigint;
    /** The ERC-20's `paused()`: its issuer's pause, which stops every lock. */
    erc20Paused: boolean;
    /** `NoriTokenBridge.previewLockERC20`: the rate fee the bridge keeps, in the token's units. */
    fee: bigint;
    /** What the recipient claims on Tempo, in the token's units (the TIP-20 has 6 decimals). */
    net: bigint;
    /** The proof queue fee `lockERC20` is sent with, in wei. */
    queueFee: bigint;
}

/** The amount and recipient the form holds, and the Ethereum account that locks. */
export interface LockRequest {
    /** In the token's units, at most 6 decimals: a TIP-20 has 6. */
    amount: string;
    /** The Tempo address the lock commits to: only it can claim. */
    recipient: string;
    /** The Ethereum account that locks, the wallet's. */
    holder: string;
}
