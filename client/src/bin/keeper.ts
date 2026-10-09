#!/usr/bin/env node
import { loadConfig, loadEnv } from '../keeper/config.js';
import { Keeper } from '../keeper/keeper.js';

const USAGE = `Usage: keeper <command> [config.json]

  create-guards   create each configured guard (the keeper key is admin)
  snapshot        one NoriSnapshot transaction for every configured query
  checkpoint      record each guard's token supply
  submit          submit reads of pending snapshots whose batch is proven
  sync-pauses     syncPause each mirrored ERC-20 whose pause changed
  apply-pauses    applyPause each pending pause sync whose batch is proven
  status          print each guard's status, then each mirror's
  unlatch         clear a tripped guard's latch (the keeper key is admin)
  run             all of the above on the configured intervals

Config: keeper.demo.json by default. Its \${VAR}s come from the repo's .env
and the deploy outputs in ethereum/ and tempo/. ETH_PRIVATE_KEY signs Ethereum
transactions and TEMPO_PRIVATE_KEY Tempo ones (the keeper key).`;

const [command, configPath = 'keeper.demo.json'] = process.argv.slice(2);
const commands = [
    'create-guards',
    'snapshot',
    'checkpoint',
    'submit',
    'sync-pauses',
    'apply-pauses',
    'status',
    'unlatch',
    'run',
];
if (!command || !commands.includes(command)) {
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
    case 'sync-pauses':
        await keeper.syncPauses();
        break;
    case 'apply-pauses':
        await keeper.applyPauses();
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
