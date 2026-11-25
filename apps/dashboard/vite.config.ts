import {readFileSync} from 'node:fs';
import {defineConfig, type Plugin} from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import {loadDashboardEnv} from './build-env';

function dashboardHeaders(apiUrl: string | undefined): Plugin {
  let apiOrigin = '';
  if (apiUrl) {
    const url = new URL(apiUrl);
    if (url.protocol !== 'https:' || url.username || url.password || !/^[a-z0-9.:[\]-]+$/i.test(url.host)) {
      throw new Error('VITE_API_URL must use an HTTPS origin without credentials.');
    }
    apiOrigin = ' ' + url.origin;
  }
  return {
    name: 'nicx-dashboard-headers',
    apply: 'build',
    generateBundle() {
      const template = readFileSync(new URL('./headers.template', import.meta.url), 'utf8');
      this.emitFile({type: 'asset', fileName: '_headers', source: template.replace('{{API_ORIGIN}}', apiOrigin)});
    },
  };
}

export default defineConfig(({command, mode}) => {
  const env = loadDashboardEnv(mode);
  const plugins = [react(), tailwind()];
  return {
    plugins: command === 'build' ? [...plugins, dashboardHeaders(env.VITE_API_URL)] : plugins,
    build: {target: 'es2022', sourcemap: false},
  };
});
