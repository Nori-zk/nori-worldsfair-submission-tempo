import { defineConfig } from 'vite';
import { viteAssets, viteTransform } from '@yaw-rx/vite';
import { loadWebEnv, WebEnvError } from '../../env.js';
import { viteWasm } from '../../plugins/vite-wasm.js';
import { viteWatchAssets } from '../../plugins/vite-watch-assets.js';

const env = loadWebEnv();
// The migrate app needs the token bridge and the token it migrates; the other apps do not.
if (env.ethereum.tokenBridgeAddress === '') throw new WebEnvError('NORI_ETH_TOKEN_BRIDGE_ADDRESS', 'is not set');
if (env.migration.token === '') throw new WebEnvError('NORI_WEB_MIGRATION_TOKEN', 'is not set');

export default defineConfig({
    root: '.',
    plugins: [viteAssets(['.css', '.html']), viteWatchAssets(), viteTransform(), viteWasm()],
    define: { NORI_WEB_ENV: JSON.stringify(env) },
    esbuild: { target: 'es2022' },
    resolve: { dedupe: ['rxjs', 'ethers', '@nori-zk/nori-bridge-tempo-sdk'] },
    optimizeDeps: {
        exclude: [
            '@nori-zk/nori-bridge-tempo-sdk',
            '@nori-zk/ethereum-tempo-proof-queue-utils-glam',
        ],
    },
    server: { port: 5181 },
    publicDir: false,
    build: { outDir: 'dist', target: 'es2022' },
});
