#!/usr/bin/env node
import { loadConfig, loadEnv } from '../keeper/config.js';
import type { MigrationConfig } from '../migration/config.js';
import { Migration } from '../migration/migration.js';

const USAGE = `Usage: migrate <command> [args] --config <config.json>

  lock <token> <amount> [tempoRecipient]
                  lock <amount> of a configured ERC-20 on Ethereum for a Tempo
                  recipient (default: the Tempo key's address)
  claim           mint each proven lock on Tempo (the Tempo key must be its recipient)
  sync-pauses     syncPause each ERC-20 whose paused() changed
  apply-pauses    applyPause each pending pause sync whose batch is proven
  status          each token on both chains: pause, locked, minted, reconciled
  run             claim, sync-pauses and apply-pauses every round

Config: migration.demo.json (Sepolia + Moderato) by default. Its \${VAR}s come from the repo's .env and
the deploy outputs in ethereum/ and tempo/. ETH_PRIVATE_KEY signs Ethereum
transactions (the holder's for lock) and TEMPO_PRIVATE_KEY Tempo ones (the
recipient's for claim; any key with a fee token for apply-pauses).`;

const args = process.argv.slice(2);
const configFlag = args.indexOf('--config');
const configPath =
    configFlag >= 0 ? args.splice(configFlag, 2)[1] : 'migration.demo.json';
const [command, ...rest] = args;
const commands = [
    'lock',
    'claim',
    'sync-pauses',
    'apply-pauses',
    'status',
    'run',
];
if (!command || !commands.includes(command) || !configPath) {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
}
if (command === 'lock' && rest.length < 2) {
    console.log(USAGE);
    process.exit(1);
}

loadEnv();
const migration = await Migration.connect(
    loadConfig<MigrationConfig>(configPath)
);
switch (command) {
    case 'lock':
        await migration.lock(rest[0], rest[1], rest[2]);
        break;
    case 'claim':
        await migration.claim();
        break;
    case 'sync-pauses':
        await migration.syncPauses();
        break;
    case 'apply-pauses':
        await migration.applyPauses();
        break;
    case 'status':
        await migration.status();
        break;
    case 'run':
        await migration.run();
        break;
}
if (command !== 'run') process.exit(0);
