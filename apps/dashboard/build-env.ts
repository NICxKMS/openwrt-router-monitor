import {fileURLToPath} from 'node:url';
import {loadEnv} from 'vite';

const dashboardDirectory = fileURLToPath(new URL('.', import.meta.url));

export function loadDashboardEnv(mode: string, envDir = dashboardDirectory) {
  const env = loadEnv(mode, envDir);
  const key = env.VITE_SUPABASE_ANON_KEY?.trim() ?? '';
  if (key.startsWith('sb_secret_')) {
    throw new Error('A secret Supabase key was assigned to a browser variable.');
  }

  const parts = key.split('.');
  if (parts.length === 3) {
    let role: unknown;
    try {
      role = JSON.parse(Buffer.from(parts[1], 'base64url').toString()).role;
    } catch {
      // An invalid JWT cannot be a Supabase service-role key.
    }
    if (role === 'service_role') {
      throw new Error('The service role key must never be used by the dashboard.');
    }
  }
  return env;
}
