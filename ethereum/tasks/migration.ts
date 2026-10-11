import { existsSync, readFileSync, writeFileSync } from 'fs';
import { task } from 'hardhat/config';
import path from 'path';
import { fileURLToPath } from 'url';
import '../logger.js';
import { Logger } from 'esm-iso-logger';

const logger = new Logger('Migration');
// NORI_ETH_ENV_DIR redirects the output (scripts/migrate-dry-run.sh uses it).
// Read when the task runs, after hardhat.config.ts has loaded .env
const envFile = () =>
    path.join(
        process.env.NORI_ETH_ENV_DIR ??
            path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
        '.env.nori-eth-migration'
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

/** DemoIssuerToken mints and pauses on demand, so it never runs on Ethereum mainnet. */
async function refuseMainnet(provider: {
    getNetwork(): Promise<{ chainId: bigint }>;
}) {
    if ((await provider.getNetwork()).chainId === 1n)
        throw new Error(
            'DemoIssuerToken is a testnet demo; refusing Ethereum mainnet'
        );
}

export const deployIssuerToken = task(
    'deployIssuerToken',
    "Deploy a DemoIssuerToken (the issuer's ERC-20 to migrate to Tempo) with the signer as issuer, and mint a supply to a holder (testnet only)"
)
    .addPositionalArgument({
        name: 'supply',
        description: 'Tokens minted to the holder (18 decimals)',
        defaultValue: '1000000',
    })
    .addOption({
        name: 'holder',
        description: 'Who gets the supply (default: the issuer)',
        defaultValue: '',
    })
    .addOption({
        name: 'name',
        description: "The token's name",
        defaultValue: 'Demo USD',
    })
    .addOption({
        name: 'symbol',
        description: "The token's symbol",
        defaultValue: 'DUSD',
    })
    .setAction(async () => ({
        default: async ({ supply, holder, name, symbol }, hre) => {
            const { ethers } = await hre.network.getOrCreate();
            await refuseMainnet(ethers.provider);
            const [issuer] = await ethers.getSigners();
            if (holder && !ethers.isAddress(holder))
                throw new Error(`Invalid --holder: ${holder}`);
            const factory = await ethers.getContractFactory('DemoIssuerToken');
            const token = await factory.deploy(name, symbol, issuer.address);
            await token.waitForDeployment();
            const address = await token.getAddress();
            const to = holder || issuer.address;
            await (await token.mint(to, ethers.parseEther(supply))).wait();
            setEnvVar(envFile(), 'NORI_ETH_ISSUER_TOKEN_ADDRESS', address);
            logger.log(
                `DemoIssuerToken ${symbol} deployed to ${address}, issuer ${issuer.address}; minted ${supply} to ${to}`
            );
            logger.log(`Wrote NORI_ETH_ISSUER_TOKEN_ADDRESS to ${envFile()}`);
        },
    }))
    .build();

export const issuerPause = task(
    'issuerPause',
    'Pause the DemoIssuerToken as its issuer (--unpause to unpause)'
)
    .addFlag({ name: 'unpause', description: 'Unpause instead' })
    .setAction(async () => ({
        default: async ({ unpause }, hre) => {
            const { ethers } = await hre.network.getOrCreate();
            await refuseMainnet(ethers.provider);
            const address = process.env.NORI_ETH_ISSUER_TOKEN_ADDRESS;
            if (!address)
                throw new Error(
                    'Missing env: NORI_ETH_ISSUER_TOKEN_ADDRESS (run deployIssuerToken)'
                );
            const token = await ethers.getContractAt(
                'DemoIssuerToken',
                address
            );
            const receipt = await (
                await (unpause ? token.unpause() : token.pause())
            ).wait();
            logger.log(
                `DemoIssuerToken: paused ${await token.paused()} (block ${receipt?.blockNumber})`
            );
        },
    }))
    .build();
