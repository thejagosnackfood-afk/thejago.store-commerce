const { spawnSync } = require('node:child_process');
let config;
try { config = JSON.parse(process.env.NEXT_PUBLIC_FIREBASE_CONFIG || '{}'); } catch { throw new Error('NEXT_PUBLIC_FIREBASE_CONFIG harus berupa JSON valid.'); }
for (const key of ['apiKey', 'appId', 'projectId', 'authDomain']) if (!config[key]) throw new Error(`Konfigurasi Firebase publik belum lengkap: ${key}`);
if (!process.env.NEXT_PUBLIC_SHOPEE_CONSOLE_URL?.startsWith('https://')) throw new Error('NEXT_PUBLIC_SHOPEE_CONSOLE_URL wajib berupa URL HTTPS konektor.');
const result = spawnSync(process.execPath, [require.resolve('next/dist/bin/next'), 'build'], {
  stdio: 'inherit', env: { ...process.env, FIREBASE_DASHBOARD_EXPORT: 'true', NEXT_PUBLIC_ONLINE_DASHBOARD: 'true' },
});
process.exit(result.status ?? 1);
