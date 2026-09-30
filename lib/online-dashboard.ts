import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
export const onlineEnabled = process.env.NEXT_PUBLIC_ONLINE_DASHBOARD === 'true';
export const connectorUrl = process.env.NEXT_PUBLIC_SHOPEE_CONSOLE_URL || 'https://shopee-api-apishopee.up.railway.app/shopee';
export function dashboardAuth() {
  const config = JSON.parse(process.env.NEXT_PUBLIC_FIREBASE_CONFIG || '{}');
  if (!config.apiKey || !config.projectId || !config.appId) {
    throw new Error('Konfigurasi login dashboard belum tersedia. Hubungi pengelola.');
  }
  return getAuth(getApps().length ? getApp() : initializeApp(config));
}
export async function dashboardApi(path: string, body?: unknown, binary = false): Promise<any> {
  const user = dashboardAuth().currentUser;
  if (!user) throw new Error('Silakan login terlebih dahulu.');
  const token = await user.getIdToken();
  const response = await fetch(`${connectorUrl}/api/dashboard${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: 'no-store', signal: AbortSignal.timeout(path === '/products/sync' ? 180000 : 60000),
  });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || `Permintaan gagal (${response.status})`); }
  return binary ? response.blob() : response.json();
}
