import backstopRaw from './artifacts/contracts/Backstop.sol/Backstop.json' with { type: 'json' };
import noriReadExampleRaw from './artifacts/contracts/NoriReadExample.sol/NoriReadExample.json' with { type: 'json' };
import type { Artifact } from '@nori-zk/tempo-token-bridge';

export const backstopJson: Artifact = backstopRaw as Artifact;
export const noriReadExampleJson: Artifact = noriReadExampleRaw as Artifact;

export * from './contracts/Backstop.const.js';
export * from './contracts/BackstopRules.const.js';
export * from './contracts/NoriRead.const.js';
export * from './types/ethers-contracts/index.js';
