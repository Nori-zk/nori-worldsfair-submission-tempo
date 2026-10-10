import { existsSync, readFileSync, writeFileSync } from 'fs';
import { task } from 'hardhat/config';
import path from 'path';
import { fileURLToPath } from 'url';
import '../logger.js';
import { Logger } from 'esm-iso-logger';

const logger = new Logger('DeployNoriTokenBridge');
// NORI_ETH_ENV_DIR redirects the output (scripts/dry-run.sh uses it). Read
// when the task runs, after hardhat.config.ts has loaded .env
const envFile = () =>
    path.join(
        process.env.NORI_ETH_ENV_DIR ??
            path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
        '.env.nori-eth-token-bridge'
    );

/** Sets `name=value` in an env file, keeping its other lines. */
function setEnvVar(file: string, name: string, value: string) {
    const kept = existsSync(file)
        ? readFileSync(file, 'utf8')
              .split('\n')
              .filter((line) => line && !line.startsWith(`${name}=`))
        : [];
    writeFileSync(file, [...kept, `${name}=${value}`].join('\n') + '\n');
}

export const deployNoriTokenBridge = task(
    'deployNoriTokenBridge',
    "Deploy nori-tempo-sdk's NoriTokenBridge on a local Ethereum fork, on the given proof queue, for a dry run's pause syncs (the deployer operates it)"
)
    .addPositionalArgument({
        name: 'proofQueue',
        description: 'The NoriProofRequestQueue the bridge enqueues on',
    })
    .setAction(async () => ({
        default: async ({ proofQueue }, hre) => {
            const { ethers, networkName } = await hre.network.getOrCreate();
            if (networkName !== 'localfork')
                throw new Error(
                    'deployNoriTokenBridge is for a local fork (ETH_NETWORK=localfork) only'
                );
            const [deployer] = await ethers.getSigners();
            const { NoriTokenBridge__factory } =
                await import('@nori-zk/ethereum-tempo-bridge');
            const bridge = await new NoriTokenBridge__factory(deployer).deploy(
                deployer.address,
                proofQueue,
                ethers.ZeroAddress
            );
            await bridge.waitForDeployment();
            const address = await bridge.getAddress();
            setEnvVar(envFile(), 'NORI_ETH_TOKEN_BRIDGE_ADDRESS', address);
            logger.log(
                `NoriTokenBridge deployed to: ${address}, enqueuing on ${proofQueue}`
            );
            logger.log(`Wrote NORI_ETH_TOKEN_BRIDGE_ADDRESS to ${envFile()}`);
        },
    }))
    .build();
