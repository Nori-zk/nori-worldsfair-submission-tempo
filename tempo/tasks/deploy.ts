import { task } from 'hardhat/config';
import '../logger.js';
import { Logger } from 'esm-iso-logger';
import { envFile, setEnvVar } from './envFile.js';

const logger = new Logger('Deploy');

export const deploy = task('deploy', 'Deploy Backstop')
    .setAction(async () => ({
        default: async (_args, hre) => {
            const { ethers } = await hre.network.getOrCreate();
            const [deployer] = await ethers.getSigners();
            const network = await ethers.provider.getNetwork();

            logger.log(`Deploying with account: ${deployer.address}`);
            logger.log(
                `Network: ${network.name} (chainId: ${network.chainId})`
            );

            const factory = await ethers.getContractFactory('Backstop');
            const backstop = await factory.deploy();
            const receipt = await backstop.deploymentTransaction()?.wait();
            if (!receipt) throw new Error('Backstop did not deploy');
            const address = await backstop.getAddress();
            logger.log(`Backstop deployed to: ${address}`);
            logger.log(`Deployed in block: ${receipt.blockNumber}`);
            logger.log(`Gas used: ${receipt.gasUsed.toString()}`);

            const file = envFile('.env.nori-tempo-backstop');
            setEnvVar(file, 'NORI_TEMPO_BACKSTOP_ADDRESS', address);
            logger.log(`Wrote NORI_TEMPO_BACKSTOP_ADDRESS to ${file}`);
        },
    }))
    .build();
