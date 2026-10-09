import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * A deploy output file in this package, or in NORI_TEMPO_ENV_DIR when set
 * (scripts/dry-run.sh uses it). Read when a task runs, after
 * hardhat.config.ts has loaded .env.
 */
export const envFile = (name: string) =>
    path.join(
        process.env.NORI_TEMPO_ENV_DIR ??
            path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
        name
    );

/** Sets `name=value` in an env file, keeping its other lines. */
export function setEnvVar(file: string, name: string, value: string) {
    const kept = existsSync(file)
        ? readFileSync(file, 'utf8')
              .split('\n')
              .filter((line) => line && !line.startsWith(`${name}=`))
        : [];
    writeFileSync(file, [...kept, `${name}=${value}`].join('\n') + '\n');
}
