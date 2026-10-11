import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { Contract } from 'ethers';
import { task } from 'hardhat/config';
import '../logger.js';
import { Logger } from 'esm-iso-logger';
import {
    ISSUER_ROLE_NAME,
    ITIP20__factory,
    ITIP20Factory__factory,
    NoriTempoTokenBridge__factory,
    PATH_USD_ADDRESS,
    PAUSE_ROLE_NAME,
    sp1VerifierJson,
    TEMPO_LOCALNET_CHAIN_ID,
    TIP20_FACTORY_ADDRESS,
    UNPAUSE_ROLE_NAME,
} from '@nori-zk/tempo-token-bridge';
import { bridgeHeadNoriSP1HeliosProgramVk } from '@nori-zk/tempo-zk-utils';
import { envFile, setEnvVar } from './envFile.js';

const logger = new Logger('DeployNoriBridge');

/**
 * `adoptMirror` arrives in @nori-zk/tempo-token-bridge 0.0.3 (nori-tempo-sdk's
 * issuer-owned mirrors). Until that is on npm, NORI_TEMPO_BRIDGE_ARTIFACT
 * names a nori-tempo-sdk checkout's NoriTempoTokenBridge.json to deploy
 * instead (scripts/migrate-dry-run.sh sets it), and the call goes through
 * this fragment.
 */
const ADOPT_MIRROR_ABI = ['function adoptMirror(address ethToken, address tip20)'];

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
    .addOption({
        name: 'adopt',
        description:
            "An Ethereum ERC-20 whose issuer (the local node's second dev account) creates its own TIP-20 and grants the bridge its roles; the bridge adopts it as the mirror (needs ethTokenBridge, and a bridge with adoptMirror)",
        defaultValue: '',
    })
    .setAction(async () => ({
        default: async ({ proofQueue, ethTokenBridge, mirror, adopt }, hre) => {
            const { ethers } = await hre.network.getOrCreate();
            if (
                (await ethers.provider.getNetwork()).chainId !==
                TEMPO_LOCALNET_CHAIN_ID
            )
                throw new Error(
                    'deployNoriBridge is for a local anvil --network tempo only'
                );
            if ((mirror || adopt) && !ethTokenBridge)
                throw new Error(
                    '--mirror and --adopt need the ethTokenBridge argument'
                );
            const [deployer, issuer] = await ethers.getSigners();

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
            const artifact = process.env.NORI_TEMPO_BRIDGE_ARTIFACT;
            const { abi, bytecode } = artifact
                ? (JSON.parse(readFileSync(artifact, 'utf8')) as {
                      abi: [];
                      bytecode: string;
                  })
                : NoriTempoTokenBridge__factory;
            const deployed = await new ethers.ContractFactory(
                abi,
                bytecode,
                deployer
            ).deploy(
                await verifier.getAddress(),
                bridgeHeadNoriSP1HeliosProgramVk,
                token,
                ethers.ZeroHash,
                ethTokenBridge || deployer.address,
                proofQueue
            );
            await deployed.waitForDeployment();
            const address = await deployed.getAddress();
            const bridge = NoriTempoTokenBridge__factory.connect(
                address,
                deployer
            );
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
            if (adopt) {
                // The issuer's side: its own TIP-20 (admin: the issuer), and the bridge's three roles
                const issuerArgs = [
                    'Demo USD',
                    'DUSD',
                    'USD',
                    PATH_USD_ADDRESS,
                    issuer.address,
                    `0x${randomBytes(32).toString('hex')}`,
                ] as const;
                const issuerFactory = factory.connect(issuer);
                const tip20Address =
                    await issuerFactory.createToken.staticCall(...issuerArgs);
                await (await issuerFactory.createToken(...issuerArgs)).wait();
                const tip20 = ITIP20__factory.connect(tip20Address, issuer);
                for (const role of [
                    ISSUER_ROLE_NAME,
                    PAUSE_ROLE_NAME,
                    UNPAUSE_ROLE_NAME,
                ])
                    await (
                        await tip20.grantRole(ethers.id(role), address)
                    ).wait();
                // Nori's side: the deployer (the mirror admin) adopts it
                await (
                    await new Contract(
                        address,
                        ADOPT_MIRROR_ABI,
                        deployer
                    ).getFunction('adoptMirror')(adopt, tip20Address)
                ).wait();
                setEnvVar(file, 'NORI_TEMPO_MIRROR_ADDRESS', tip20Address);
                logger.log(
                    `Mirror of ${adopt}: ${tip20Address} (the issuer's TIP-20, admin ${issuer.address}, adopted)`
                );
            }
            logger.log(`Wrote NORI_TEMPO_TOKEN_BRIDGE_ADDRESS to ${file}`);
        },
    }))
    .build();
