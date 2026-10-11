import { defer, forkJoin, map, type Observable, switchMap } from 'rxjs';
import { Contract, isAddress, parseUnits } from 'ethers';
import { NoriTokenBridge__factory } from '@nori-zk/ethereum-tempo-bridge';
import { type EthereumProvider } from '@nori-zk/nori-bridge-tempo-sdk';
import { type LockRequest, type Quote } from './quote.js';

/** The ERC-20 calls that name a token, scale an amount and tell whether it can be locked. */
const TOKEN_ABI = [
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function paused() view returns (bool)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
];

/** A positive amount with at most 6 decimals: a TIP-20 has 6, and the bridge refuses dust below one unit. */
const AMOUNT = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;

/**
 * Whether a request can be read: a positive amount with at most 6
 * decimals, and the recipient and holder are addresses.
 *
 * @param request The amount, recipient and holder.
 * @returns Whether all are valid.
 */
export const isComplete = ({ amount, recipient, holder }: LockRequest): boolean =>
    AMOUNT.test(amount) && /[1-9]/.test(amount) && isAddress(recipient) && isAddress(holder);

/** Where a quote is read: the ERC-20 and the token bridge that locks it. */
export interface QuoteAddresses {
    token: string;
    tokenBridge: string;
}

/**
 * The token, the holder's balance and allowance, and the bridge's preview of
 * locking the amount, read together.
 *
 * @param provider The provider the read goes through.
 * @param addresses The ERC-20 and the token bridge.
 * @param request The amount and the holder.
 * @returns The quote, once.
 */
export const quote$ = (
    provider: EthereumProvider,
    { token, tokenBridge }: QuoteAddresses,
    { amount, holder }: LockRequest,
): Observable<Quote> => {
    const erc20 = new Contract(token, TOKEN_ABI, provider);
    const bridge = NoriTokenBridge__factory.connect(tokenBridge, provider);
    return forkJoin({
        symbol: defer(async () => erc20.getFunction('symbol')() as Promise<string>),
        decimals: defer(async () => erc20.getFunction('decimals')() as Promise<bigint>).pipe(
            map(Number),
        ),
    }).pipe(
        switchMap(({ symbol, decimals }) => {
            const units = parseUnits(amount, decimals);
            return forkJoin({
                balance: defer(
                    async () => erc20.getFunction('balanceOf')(holder) as Promise<bigint>,
                ),
                allowance: defer(
                    async () =>
                        erc20.getFunction('allowance')(holder, tokenBridge) as Promise<bigint>,
                ),
                erc20Paused: defer(async () => erc20.getFunction('paused')() as Promise<boolean>),
                preview: defer(async () => bridge.previewLockERC20(token, units)),
            }).pipe(
                map(({ balance, allowance, erc20Paused, preview: [queueFee, fee, net] }) => ({
                    symbol,
                    decimals,
                    units,
                    balance,
                    allowance,
                    erc20Paused,
                    fee,
                    net,
                    queueFee,
                })),
            );
        }),
    );
};

/**
 * Why a quoted lock cannot go ahead, or `undefined` when it can: the issuer
 * paused the token, or the holder holds too little.
 *
 * @param quote The quote.
 * @returns The reason, in the domain's words.
 */
export const lockBlocker = (quote: Quote): 'paused' | 'balance' | undefined => {
    if (quote.erc20Paused) return 'paused';
    if (quote.balance < quote.units) return 'balance';
    return undefined;
};
