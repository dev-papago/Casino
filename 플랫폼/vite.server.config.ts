// The ledger server as one JavaScript file for the exe (dist-server/server.mjs): Electron runs it in its main
// process. Node built-ins stay imports; there are no other packages.
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'src/server/server.ts',
    outDir: 'dist-server',
    target: 'node22',
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'server.mjs', format: 'es' } },
  },
  ssr: { noExternal: true },
});
