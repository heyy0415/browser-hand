import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import fs from 'fs';
import path from 'path';

// 自定义插件：将HTML文件从src目录移到根目录
function moveHtmlPlugin() {
  return {
    name: 'move-html',
    apply: 'build',
    writeBundle(options) {
      const outDir = options.dir;
      const files = ['side_panel.html', 'popup.html'];
      
      files.forEach((file) => {
        const srcHtmlPath = path.join(outDir, 'src', file);
        const destHtmlPath = path.join(outDir, file);
        
        if (fs.existsSync(srcHtmlPath)) {
          const content = fs.readFileSync(srcHtmlPath, 'utf-8');
          fs.writeFileSync(destHtmlPath, content);
          fs.unlinkSync(srcHtmlPath);
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), moveHtmlPlugin()],
  resolve: {
    alias: {
      '@browser-hand/ui': resolve(__dirname, '../../packages/ui/src'),
      '@browser-hand/engine': resolve(__dirname, '../../packages/engine'),
    },
  },
  publicDir: 'public',
  build: {
    outDir: '../../dist/extension',
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: {
        side_panel: resolve(__dirname, 'src/side_panel.html'),
        popup: resolve(__dirname, 'src/popup.html'),
        background: resolve(__dirname, 'src/background.ts'),
        'content-script': resolve(__dirname, 'src/content-script.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
      },
    },
  },
});
