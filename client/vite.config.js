import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      // React rarely changes: kept apart, browsers keep it cached across our releases.
      output: { manualChunks: { react: ['react', 'react-dom'] } },
    },
  },
  server: {
    port: 5173,
    // The Android SDK/JDK, native builds and the desktop installers hold hundreds of thousands of
    // files; watching them freezes the dev server after a release build.
    watch: { ignored: ['**/android-tools/**', '**/android/**', '**/desktop/**', '**/nextgo/**', '**/dist/**'] },
    proxy: { '/api': { target: 'http://localhost:4000', ws: true } },
    allowedHosts: [
      'trustable-sample-endowment.ngrok-free.dev'
    ]
  },
});
