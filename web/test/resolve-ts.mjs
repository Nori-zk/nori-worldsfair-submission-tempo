// Preload for `node --test` in a web/ package. The browser code imports its
// own modules with a `.js` suffix, which Vite maps onto the `.ts` sources;
// this hook does the same for Node. Nothing is compiled: Node strips the
// types itself. Unlike Vite it defines no `NORI_WEB_ENV`, so a test passes
// it what it reads.
import { register } from 'node:module';

register(
    `data:text/javascript,${encodeURIComponent(`
        import { existsSync } from 'node:fs';
        import { fileURLToPath } from 'node:url';
        export async function resolve(specifier, context, next) {
            if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
                const asTs = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
                if (existsSync(fileURLToPath(asTs))) return next(asTs.href, context);
            }
            return next(specifier, context);
        }
    `)}`,
    import.meta.url,
);
