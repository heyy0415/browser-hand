import { build } from 'vite';
import react from '@vitejs/plugin-react';

async function buildWeb() {
  await build({
    plugins: [react()],
    root: 'app/web-page',
    build: {
      outDir: '../../dist/web-page',
      emptyOutDir: true,
    },
  });
}

buildWeb().catch(console.error);
