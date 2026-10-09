import { randomBytes } from 'crypto';
import { task } from 'hardhat/config';
import '../logger.js';
import { Logger } from 'esm-iso-logger';
import {
    ISSUER_ROLE_NAME,
    ITIP20__factory,
    ITIP20Factory__factory,
    PATH_USD_ADDRESS,
    TEMPO_MAINNET_CHAIN_ID,
    TIP20_FACTORY_ADDRESS,
} from '@nori-zk/tempo-token-bridge';
import { envFile, setEnvVar } from './envFile.js';

const logger = new Logger('Demo');

export const deployDemo = task(
    'deployDemo',
    'Create a demo TIP-20 for the Backstop demo guard and mint its supply to the deployer (testnet only)'
)
    .addPositionalArgument({
        name: 'supply',
        description: 'Supply to mint, in tokens (6 decimals)',
        defaultValue: '116700',
    })
    .addOption({
        name: 'envVar',
        description:
            'Variable that gets the address in .env.nori-tempo-demo (e.g. a second, untouched token)',
        defaultValue: 'BACKSTOP_DEMO_TOKEN',
    })
    .setAction(async () => ({
        default: async ({ supply, envVar }, hre) => {
            if (!/^[A-Z_][A-Z0-9_]*$/.test(envVar))
                throw new Error(`Invalid --env-var: ${envVar}`);
            const { ethers } = await hre.network.getOrCreate();
            if (
                (await ethers.provider.getNetwork()).chainId ===
                TEMPO_MAINNET_CHAIN_ID
            )
                throw new Error(
                    'The demo token is a testnet demo; refusing Tempo mainnet'
                );
            const [deployer] = await ethers.getSigners();

            // Created through TIP20Factory with the deployer as admin and
            // pathUSD as its quote token; currency ETH, so not a fee token
            const factory = ITIP20Factory__factory.connect(
                TIP20_FACTORY_ADDRESS,
                deployer
            );
            const salt = `0x${randomBytes(32).toString('hex')}`;
            const tokenArgs = [
                'Backstop Demo',
                'BDEMO',
                'ETH',
                PATH_USD_ADDRESS,
                deployer.address,
                salt,
            ] as const;
            const address = await factory.createToken.staticCall(...tokenArgs);
            await (await factory.createToken(...tokenArgs)).wait();

            // The deployer issues the demo supply to itself
            const token = ITIP20__factory.connect(address, deployer);
            await (
                await token.grantRole(
                    ethers.id(ISSUER_ROLE_NAME),
                    deployer.address
                )
            ).wait();
            await (
                await token.mint(
                    deployer.address,
                    ethers.parseUnits(supply, await token.decimals())
                )
            ).wait();

            const file = envFile('.env.nori-tempo-demo');
            setEnvVar(file, envVar, address);
            logger.log(
                `Demo token ${address}, supply ${supply}, held by ${deployer.address}`
            );
            logger.log(`Wrote ${envVar} to ${file}`);
        },
    }))
    .build();
