import { build } from 'vite';
import react from '@vitejs/plugin-react';

async function buildWeb() {
  await build({
    plugins: [react()],
    root: 'apps/web',
    build: {
      outDir: '../../dist/web',
      emptyOutDir: true,
    },
  });
}

buildWeb().catch(console.error);
