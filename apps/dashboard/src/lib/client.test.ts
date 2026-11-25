import {afterEach, expect, it, vi} from 'vitest';

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({auth: {getSession: async () => ({data: {session: {access_token: 'fixture'}}})}}),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('reports an unreadable mutation response as unconfirmed', async () => {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://test.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'fixture-key');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Proxy error</html>')));
  const {ownerApi} = await import('./client');
  await expect(ownerApi('/api/v1/enrollment', {name: 'Test router'})).rejects.toThrow('Could not confirm completion');
});
