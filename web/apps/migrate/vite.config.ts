import { defineConfig } from 'vite';
import { viteAssets, viteTransform } from '@yaw-rx/vite';
import { loadWebEnv } from '../../env.js';
import { viteWasm } from '../../plugins/vite-wasm.js';
import { viteWatchAssets } from '../../plugins/vite-watch-assets.js';

// Without the token bridge or the token it migrates, the page says it is not configured (app-root.ts).
const env = loadWebEnv();

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
