/** What reading a request finds: the asset, the balance the snapshot will record, and the fee. */
export interface Preview {
    /** The asset's symbol: `ETH`, or the token's `symbol()`. */
    symbol: string;
    /** The asset's decimals: 18 for ETH, or the token's `decimals()`. */
    decimals: number;
    /** The balance the snapshot will record, in the asset's smallest unit. */
    balance: bigint;
    /** `NoriSnapshot.snapshotFee()`, in wei. */
    fee: bigint;
}
