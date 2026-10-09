import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { type HardhatUserConfig } from 'hardhat/config';
import hardhatTypechain from '@nomicfoundation/hardhat-typechain';
import hardhatEthers from '@nomicfoundation/hardhat-ethers';
import hardhatEthersChaiMatchers from '@nomicfoundation/hardhat-ethers-chai-matchers';
import hardhatMocha from '@nomicfoundation/hardhat-mocha';
import './logger.js';
import { Logger } from 'esm-iso-logger';

import { deploy } from './tasks/deploy.js';
import { deployDemo } from './tasks/demo.js';
import { deployNoriBridge } from './tasks/deployNoriBridge.js';

const logger = new Logger('HardhatConfig');

// The repo's one .env; the shell environment wins over it
dotenv.config({
    path: fileURLToPath(new URL('../.env', import.meta.url)),
    quiet: true,
});

const possibleNetworkName = process.env.TEMPO_NETWORK;
const possibleRpcUrl = process.env.TEMPO_RPC_NETWORK_URL;
const possiblePrivateKey = process.env.TEMPO_PRIVATE_KEY;

/** A local Tempo node (`anvil --network tempo`), whose unlocked dev accounts sign. */
const LOCALNET = 'localnet';
const LOCALNET_RPC_URL = 'http://127.0.0.1:8545';

const issues: string[] = [];

if (!possibleNetworkName) issues.push('Missing required env: TEMPO_NETWORK');
if (
    possibleNetworkName &&
    possibleNetworkName !== 'hardhat' &&
    possibleNetworkName !== LOCALNET
) {
    if (!possibleRpcUrl)
        issues.push('Missing required env: TEMPO_RPC_NETWORK_URL');
    if (!possiblePrivateKey)
        issues.push('Missing required env: TEMPO_PRIVATE_KEY');
}

if (issues.length) {
    logger.error('HardhatConfig encountered errors:');
    issues.forEach((issue, idx) => logger.warn(`  ${idx + 1}: ${issue}`));
    logger.fatal(
        'Due to issues with environment variables hardhat cannot continue.'
    );
    process.exit(1);
}

const networkName = possibleNetworkName as string;

const networks: NonNullable<HardhatUserConfig['networks']> = {};

if (networkName === LOCALNET) {
    networks[networkName] = {
        url: possibleRpcUrl || LOCALNET_RPC_URL,
        accounts: 'remote',
        type: 'http',
    };
} else if (networkName !== 'hardhat') {
    networks[networkName] = {
        url: possibleRpcUrl as string,
        accounts: [possiblePrivateKey as string],
        type: 'http',
    };
}

logger.log(`Running on network "${networkName}"`);
if (networkName === 'hardhat') {
    logger.log('Using built-in Hardhat network for compiling.');
} else if (networkName === LOCALNET) {
    logger.log(
        `Using local Tempo node at ${possibleRpcUrl || LOCALNET_RPC_URL} and its unlocked dev accounts.`
    );
} else {
    logger.log(`Using RPC URL: ${possibleRpcUrl}`);
    logger.log('One private key loaded for deployment.');
}

const config: HardhatUserConfig = {
    networks,
    tasks: [deploy, deployDemo, deployNoriBridge],
    plugins: [
        hardhatMocha,
        hardhatTypechain,
        hardhatEthers,
        hardhatEthersChaiMatchers,
    ],
    solidity: {
        version: '0.8.28',
        settings: {
            optimizer: {
                enabled: true,
                runs: 200,
            },
            viaIR: true,
        },
    },
    test: {
        mocha: {
            rootHooks: {
                afterAll() {
                    // Force exit after tests — ethers .once() listeners keep the process alive.
                    // No code: keep the exitCode Hardhat sets when a test fails
                    setTimeout(() => process.exit(), 1000).unref();
                },
            },
        },
    },
    paths: {
        sources: './contracts',
        cache: './cache',
        artifacts: './artifacts',
    },
};

export default config;
