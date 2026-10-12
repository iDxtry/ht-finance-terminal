import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/lightweight-charts/')) return 'charts';
          if (id.includes('/node_modules/@supabase/')) return 'supabase';
          return undefined;
        },
      },
    },
  },
});
