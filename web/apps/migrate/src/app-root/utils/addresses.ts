/**
 * The contracts the migrate app uses, from `web/.env`: the ERC-20 it
 * migrates, the token bridge holders lock it in, the proof queue that
 * bridge enqueues on, and the Nori bridge on Tempo that proves the queue
 * and mints the ERC-20's TIP-20. The app's vite config checks they are set.
 */
export const MIGRATE_ADDRESSES = {
    token: NORI_WEB_ENV.migration.token,
    tokenBridge: NORI_WEB_ENV.ethereum.tokenBridgeAddress,
    proofQueue: NORI_WEB_ENV.ethereum.proofQueueAddress,
    tempoBridge: NORI_WEB_ENV.tempo.bridgeAddress,
};
