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

it.each([
  {dev: true, optIn: '1', url: 'http://127.0.0.1:54321', expected: true},
  {dev: false, optIn: '1', url: 'http://127.0.0.1:54321', expected: false},
  {dev: true, optIn: '', url: 'http://127.0.0.1:54321', expected: false},
  {dev: true, optIn: '1', url: 'http://127.0.0.1.example.test:54321', expected: false},
  {dev: true, optIn: '1', url: 'http://example.test:54321', expected: false},
])('validates development database URL $url with development=$dev and opt-in=$optIn',
  async ({dev, optIn, url, expected}) => {
    vi.stubEnv('DEV', dev);
    vi.stubEnv('VITE_NICX_DEV_LOOPBACK', optIn);
    vi.stubEnv('VITE_SUPABASE_URL', url);
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'fixture-key');

    const {configured, db} = await import('./client');
    expect(configured).toBe(expected);
    expect(db !== null).toBe(expected);
  });
