#!/usr/bin/env node
import { type Observable } from 'rxjs';
import { loadConfig, loadEnv } from '../keeper/config.js';
import { type MigrationConfig } from '../migration/config.js';
import { Migration } from '../migration/migration.js';

const USAGE = `Usage: migrate <command> [args] [--config <config.json>]

  lock <token> <amount> [recipient]   lock an ERC-20 on Ethereum for a Tempo recipient
                                      (default: the TEMPO_PRIVATE_KEY address), paying the
                                      proof queue fee in ETH; approves the bridge first if needed
  claim                               mint each pending lock for the TEMPO_PRIVATE_KEY address
                                      on Tempo once Nori has proven it
  status                              locked on Ethereum against minted on Tempo, per token

Config: migration.demo.json by default. Its \${VAR}s come from the repo's .env
and the deploy outputs in ethereum/ and tempo/. ETH_PRIVATE_KEY is the holder
on Ethereum, TEMPO_PRIVATE_KEY the recipient on Tempo. The ERC-20's pause
reaches its mirror through the keeper (sync-pauses, apply-pauses).`;

const args = process.argv.slice(2);
const configAt = args.indexOf('--config');
const configPath = configAt >= 0 ? args[configAt + 1] : 'migration.demo.json';
const [command, ...rest] = configAt >= 0 ? [...args.slice(0, configAt), ...args.slice(configAt + 2)] : args;

/** Each command: what it does, until it completes. */
const commands: Record<string, (migration: Migration) => Observable<unknown> | undefined> = {
    lock: (migration) => {
        const [token, amount, recipient] = rest;
        return token && amount ? migration.lock$(token, amount, recipient) : undefined;
    },
    claim: (migration) => migration.claim$(),
    status: (migration) => migration.status$(),
};

const command$ = command === undefined ? undefined : commands[command];
if (!command$ || !configPath) {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
}

loadEnv();
const migration = Migration.connect(loadConfig<MigrationConfig>(configPath));
const run$ = command$(migration);
if (!run$) {
    console.log(USAGE);
    migration.close();
    process.exit(1);
}
run$.subscribe({
    complete: () => {
        migration.close();
        process.exit(0);
    },
    error: (error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        migration.close();
        process.exit(1);
    },
});
