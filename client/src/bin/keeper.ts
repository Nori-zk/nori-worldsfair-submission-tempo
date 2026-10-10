#!/usr/bin/env node
import { type Observable } from 'rxjs';
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

/** Each command: what it does, until it completes (`run` never does). */
const commands: Record<string, (keeper: Keeper) => Observable<unknown>> = {
    'create-guards': (keeper) => keeper.createGuards$(),
    snapshot: (keeper) => keeper.snapshot$(),
    checkpoint: (keeper) => keeper.checkpoint$(),
    submit: (keeper) => keeper.submit$(),
    'sync-pauses': (keeper) => keeper.syncPauses$(),
    'apply-pauses': (keeper) => keeper.applyPauses$(),
    status: (keeper) => keeper.status$(),
    unlatch: (keeper) => keeper.unlatch$(),
    run: (keeper) => keeper.run$(),
};

const [command, configPath = 'keeper.demo.json'] = process.argv.slice(2);
const run = command === undefined ? undefined : commands[command];
if (!run) {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
}

loadEnv();
const keeper = Keeper.connect(loadConfig(configPath));
run(keeper).subscribe({
    complete: () => {
        keeper.close();
        process.exit(0);
    },
    error: (error: unknown) => {
        console.error(error);
        keeper.close();
        process.exit(1);
    },
});
