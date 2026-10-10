#!/usr/bin/env node
import { loadConfig, loadEnv } from '../keeper/config.js';
import { Keeper } from '../keeper/keeper.js';

const USAGE = `Usage: keeper <command> [config.json]

  create-guards   create each configured guard (the keeper key is admin)
  snapshot        one NoriSnapshot transaction for every configured query
  checkpoint      record each guard's token supply
  submit          submit reads of pending snapshots whose batch is proven
  status          print Nori's progress, then each guard's status
  unlatch         clear a tripped guard's latch (the keeper key is admin)
  run             all of the above on the configured intervals

Config: the path given (scripts/dry-run.sh writes one). Its \${VAR}s come
from the repo's .env and the deploy outputs in ethereum/ and tempo/. ETH_PRIVATE_KEY signs Ethereum
transactions and TEMPO_PRIVATE_KEY Tempo ones (the keeper key).`;

const [command, configPath] = process.argv.slice(2);
const commands = [
    'create-guards',
    'snapshot',
    'checkpoint',
    'submit',
    'status',
    'unlatch',
    'run',
];
if (!command || !commands.includes(command) || !configPath) {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
}

loadEnv();
const keeper = await Keeper.connect(loadConfig(configPath));
switch (command) {
    case 'create-guards':
        await keeper.createGuards();
        break;
    case 'snapshot':
        await keeper.snapshot();
        break;
    case 'checkpoint':
        await keeper.checkpoint();
        break;
    case 'submit':
        await keeper.submit();
        break;
    case 'status':
        await keeper.status();
        break;
    case 'unlatch':
        await keeper.unlatch();
        break;
    case 'run':
        await keeper.run();
        break;
}
if (command !== 'run') process.exit(0);
