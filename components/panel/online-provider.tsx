'use client';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import { dashboardApi, dashboardAuth, onlineEnabled } from '../../lib/online-dashboard';
const OnlineContext = createContext<{ user: User | null; logout: () => void }>({ user: null, logout: () => {} });
export const useOnlineAccount = () => useContext(OnlineContext);
function loginError(error: unknown) {
  const code = (error as { code?: string })?.code;
  if (code === 'auth/popup-blocked') return 'Izinkan pop-up untuk situs ini, lalu klik Masuk dengan Google lagi.';
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return 'Login dibatalkan. Klik Masuk dengan Google untuk mencoba lagi.';
  if (code === 'auth/unauthorized-domain') return 'Domain dashboard belum diizinkan untuk login Google. Hubungi pengelola.';
  if (code === 'auth/network-request-failed') return 'Koneksi login terputus. Periksa internet dan coba lagi.';
  return error instanceof Error ? error.message : 'Login Google gagal.';
}
export default function OnlineProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null), [ready, setReady] = useState(false), [allowed, setAllowed] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    if (!onlineEnabled) return;
    let stop = () => {};
    try {
      stop = onAuthStateChanged(dashboardAuth(), async next => {
        const current = ++generation.current;
        setUser(next); setAllowed(false); setReady(false); setError('');
        if (next) {
          try { await dashboardApi('/me'); if (current === generation.current) setAllowed(true); }
          catch (e) { if (current === generation.current) setError(loginError(e)); }
        }
        if (current === generation.current) setReady(true);
      }, e => { setError(loginError(e)); setReady(true); });
    } catch (e) { setError(loginError(e)); setReady(true); }
    return () => { generation.current++; stop(); };
  }, []);
  async function login() {
    setBusy(true); setError('');
    try { const provider = new GoogleAuthProvider(); provider.setCustomParameters({ prompt: 'select_account' }); await signInWithPopup(dashboardAuth(), provider); }
    catch (e) { setError(loginError(e)); }
    finally { setBusy(false); }
  }
  async function retry() {
    const current = ++generation.current;
    setBusy(true); setError('');
    try { await dashboardApi('/me'); if (current === generation.current) setAllowed(true); }
    catch (e) { if (current === generation.current) setError(loginError(e)); }
    finally { if (current === generation.current) setBusy(false); }
  }
  async function logout() {
    generation.current++; setAllowed(false); setBusy(true);
    try { await signOut(dashboardAuth()); }
    catch (e) { setError(loginError(e)); }
    finally { setBusy(false); }
  }
  if (!onlineEnabled) return <>{children}</>;
  if (!ready) return <main className="online-login"><h1>Dashboard toko</h1><p role="status">Memeriksa sesi login…</p></main>;
  if (!user || !allowed) return <main className="online-login"><h1>Dashboard toko</h1><p>Masuk dengan akun Google pemilik untuk melihat produk dan mengatur pengiriman Shopee.</p>{error && <p role="alert" className="form-error">{error}</p>}{user && <><p>{user.email}</p><button className="primary" disabled={busy} onClick={retry}>Coba verifikasi lagi</button>{' '}</>}<button className="primary" disabled={busy} onClick={user ? logout : login}>{user ? 'Ganti akun' : busy ? 'Menghubungkan…' : 'Masuk dengan Google'}</button></main>;
  return <OnlineContext.Provider value={{ user, logout }}>{children}</OnlineContext.Provider>;
}
