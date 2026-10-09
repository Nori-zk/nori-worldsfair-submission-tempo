import { randomBytes } from 'crypto';
import { task } from 'hardhat/config';
import '../logger.js';
import { Logger } from 'esm-iso-logger';
import {
    ISSUER_ROLE_NAME,
    ITIP20__factory,
    ITIP20Factory__factory,
    NoriTempoTokenBridge__factory,
    PATH_USD_ADDRESS,
    sp1VerifierJson,
    TEMPO_LOCALNET_CHAIN_ID,
    TIP20_FACTORY_ADDRESS,
} from '@nori-zk/tempo-token-bridge';
import { bridgeHeadNoriSP1HeliosProgramVk } from '@nori-zk/tempo-zk-utils';
import { envFile, setEnvVar } from './envFile.js';

const logger = new Logger('DeployNoriBridge');

export const deployNoriBridge = task(
    'deployNoriBridge',
    "Deploy the Nori bridge (nori-tempo-sdk's NoriTempoTokenBridge, its SP1 verifier and nETH) on a local Tempo node, for a dry run whose fake prover writes its batches"
)
    .addPositionalArgument({
        name: 'proofQueue',
        description: 'The Ethereum NoriProofRequestQueue the bridge proves',
    })
    .addPositionalArgument({
        name: 'ethTokenBridge',
        description:
            'The Ethereum NoriTokenBridge whose deposits and pause states the bridge accepts (default: the deployer, so none)',
        defaultValue: '',
    })
    .addOption({
        name: 'mirror',
        description:
            "An Ethereum ERC-20 to register a TIP-20 mirror of, whose pause the keeper keeps in step (needs ethTokenBridge)",
        defaultValue: '',
    })
    .setAction(async () => ({
        default: async ({ proofQueue, ethTokenBridge, mirror }, hre) => {
            const { ethers } = await hre.network.getOrCreate();
            if (
                (await ethers.provider.getNetwork()).chainId !==
                TEMPO_LOCALNET_CHAIN_ID
            )
                throw new Error(
                    'deployNoriBridge is for a local anvil --network tempo only'
                );
            if (mirror && !ethTokenBridge)
                throw new Error('--mirror needs the ethTokenBridge argument');
            const [deployer] = await ethers.getSigners();

            const verifier = await new ethers.ContractFactory(
                sp1VerifierJson.abi,
                sp1VerifierJson.bytecode,
                deployer
            ).deploy();
            await verifier.waitForDeployment();

            const factory = ITIP20Factory__factory.connect(
                TIP20_FACTORY_ADDRESS,
                deployer
            );
            const tokenArgs = [
                'nETH',
                'nETH',
                'ETH',
                PATH_USD_ADDRESS,
                deployer.address,
                `0x${randomBytes(32).toString('hex')}`,
            ] as const;
            const token = await factory.createToken.staticCall(...tokenArgs);
            await (await factory.createToken(...tokenArgs)).wait();

            // Starts at head 0 and cursor 0; the fake prover writes its state
            const bridge = await new NoriTempoTokenBridge__factory(
                deployer
            ).deploy(
                await verifier.getAddress(),
                bridgeHeadNoriSP1HeliosProgramVk,
                token,
                ethers.ZeroHash,
                ethTokenBridge || deployer.address,
                proofQueue
            );
            await bridge.waitForDeployment();
            const address = await bridge.getAddress();
            await (
                await ITIP20__factory.connect(token, deployer).grantRole(
                    ethers.id(ISSUER_ROLE_NAME),
                    address
                )
            ).wait();

            const file = envFile('.env.nori-tempo-bridge');
            setEnvVar(file, 'NORI_TEMPO_TOKEN_BRIDGE_ADDRESS', address);
            logger.log(
                `NoriTempoTokenBridge ${address}, proving queue ${proofQueue}`
            );
            if (mirror) {
                // The deployer is the bridge's mirror admin
                await (
                    await bridge.registerMirror(
                        mirror,
                        'Mirror',
                        'MIRROR',
                        'USD',
                        `0x${randomBytes(32).toString('hex')}`
                    )
                ).wait();
                logger.log(
                    `Mirror of ${mirror}: ${await bridge.mirrorOf(mirror)}`
                );
            }
            logger.log(`Wrote NORI_TEMPO_TOKEN_BRIDGE_ADDRESS to ${file}`);
        },
    }))
    .build();
