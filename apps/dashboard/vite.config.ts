import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwind()],
  build: {
    target: 'es2022',
    sourcemap: false,
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@supabase/')) return 'supabase';
          if (id.includes('react-dom') || id.includes('/react/')) return 'react';
        },
      },
    },
  },
});
