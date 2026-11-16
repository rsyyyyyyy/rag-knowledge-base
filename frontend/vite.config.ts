import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const apiTarget = (env.VITE_DEV_API_TARGET || env.VITE_API_BASE_URL || 'http://127.0.0.1:8001')
    .replace(/\/api\/?$/, '');

  return {
    plugins: [react()],
    server: {
      open: true,
      proxy: { '/api': { target: apiTarget, changeOrigin: true } },
    },
  };
});
