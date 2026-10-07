import { useEffect, useMemo, useRef, useState } from 'react';
import { get, post, setToken, setUnauthorizedHandler } from './lib/api';
import { connectEvents } from './lib/events';
import { setOverrides } from './lib/shortcuts';
import { ToastHost, ApprovalHost, useToast, Msg } from './components/ui';
import RateChanges from './components/RateChanges';
import { Card } from './manager/common';
import { rs } from './lib/fmt';
import Pos from './pos/Pos';
import Dashboard from './manager/Dashboard';
import Products from './manager/Products';
import Bills from './manager/Bills';
import { Customers, Purchases, Stock } from './manager/Parties';
import { Reports, Users, Terminals, Hardware, Settings, Backup, Audit } from './manager/Admin';

function makeBus() { const m = new Map(); return { on(e, fn) { if (!m.has(e)) m.set(e, new Set()); m.get(e).add(fn); return () => m.get(e).delete(fn); }, emit(e, d) { (m.get(e) || []).forEach((fn) => { try { fn(d); } catch (x) { console.error(x); } }); } }; }

function Login({ terminal, onLogin, health }) {
  const [u, setU] = useState(''), [p, setP] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const go = async (e) => { e.preventDefault(); setBusy(true); setErr(''); try { const r = await post('/login', { username: u, password: p }); setToken(r.token); onLogin(r.user); } catch (x) { setErr(x.message); setP(''); } finally { setBusy(false); } };
  return <div className="loginwrap"><form className="loginbox" onSubmit={go}>
    <h2>Billing Login</h2><div className="mut">{terminal ? `${terminal.code} · ${terminal.name}` : 'Browser (view only — billing needs a counter PC)'}</div>
    <label className="fld"><span>Username</span><input value={u} onChange={(e) => setU(e.target.value)} autoFocus autoComplete="username" /></label>
    <label className="fld"><span>Password or PIN</span><input type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" /></label>
    <Msg m={err} /><button className="b big" disabled={busy}>{busy ? 'Logging in…' : 'Login (Enter)'}</button>
    <div className={health ? 'ok' : 'bad'}>{health ? 'SERVER CONNECTED' : 'SERVER DISCONNECTED'}</div>
  </form></div>;
}

const NAV = [['dash', 'Dashboard', 'dashboard.view'], ['pos', 'Billing (POS)', 'bill.create'], ['bills', 'Bills', 'bill.view_all'], ['products', 'Products & Rates', 'product.edit'], ['rates', 'Rate changes', 'product.view'], ['customers', 'Customers', 'customer.edit'], ['purchases', 'Purchases', 'purchase.edit'], ['stock', 'Stock', 'stock.view'],
  ['reports', 'Reports', 'report.sales'], ['users', 'Users', 'user.manage'], ['terminals', 'Counters', 'terminal.manage'], ['hardware', 'Hardware', 'terminal.manage'], ['settings', 'Settings', 'settings.manage'], ['backup', 'Backup', 'backup.manage'], ['audit', 'Audit log', 'audit.view']];

function Shell() {
  const toast = useToast();
  const bus = useMemo(makeBus, []);
  const [user, setUser] = useState(null), [terminal, setTerminal] = useState(undefined), [conf, setConf] = useState(null), [products, setProducts] = useState([]), [serverOk, setServerOk] = useState(true), [tab, setTab] = useState(null), [health, setHealth] = useState(false);
  useEffect(() => { get('/health').then(() => setHealth(true)).catch(() => setHealth(false)); get('/terminal').then(setTerminal).catch(() => setTerminal(null)); }, []);
  const logout = async (why) => { try { await post('/logout'); } catch (e) {} setToken(''); setUser(null); setTab(null); if (why) toast(why, 'warn'); };
  useEffect(() => setUnauthorizedHandler((m) => { setToken(''); setUser(null); toast(m || 'Session ended. Please login again.', 'warn'); }), []);
  const loadMaster = () => Promise.all([get('/config').then((c) => { setConf(c); setOverrides(c.shortcuts); }), user.perms.includes('product.view') ? get('/products').then(setProducts) : null]).catch((e) => toast(e.message, 'error'));
  useEffect(() => {
    if (!user) return;
    loadMaster();
    setTab(user.perms.includes('dashboard.view') ? 'dash' : 'pos');
    return connectEvents({
      onStatus: setServerOk,
      onSync: () => { loadMaster(); bus.emit('sync'); },
      onEvent: (e, d) => {
        if (e === 'product:price-updated') {
          setProducts((ps) => ps.map((p) => (p._id === d.productId ? { ...p, rate: d.rate, priceVersion: d.priceVersion } : p)));
          // every logged-in PC (operator and manager) is told about every rate change
          toast(`Rate changed: ${d.name} ${d.old != null ? '₹' + rs(d.old) + ' → ' : ''}₹${rs(d.rate)}${d.by ? ' (by ' + d.by + ')' : ''}`, 'warn');
        }
        else if (e === 'product:created' || e === 'product:updated' || e === 'product:status-changed') setProducts((ps) => (ps.some((p) => p._id === d._id) ? ps.map((p) => (p._id === d._id ? d : p)) : [...ps, d].sort((a, b) => a.name.localeCompare(b.name))));
        else if (e === 'inventory:updated') { clearTimeout(window.__invT); window.__invT = setTimeout(() => get('/products').then(setProducts).catch(() => {}), 1500); }
        else if (e === 'settings:updated') { setConf(d); setOverrides(d.shortcuts); }
        else if (e === 'user:permission-updated') get('/me').then((u) => setUser((x) => ({ ...x, ...u }))).catch(() => logout('Your access was changed. Please login again.'));
        else if (e === 'data:restored') { loadMaster(); toast('Data was restored from backup by the manager', 'warn'); }
        bus.emit(e, d);
      },
    });
  }, [user?.id]);
  useEffect(() => bus.on('refresh', () => { loadMaster(); toast('Data refreshed', 'ok'); }), [user]);
  // health check while disconnected so the login screen and status bar recover by themselves
  const hb = useRef(); useEffect(() => { hb.current = setInterval(() => get('/health').then(() => setHealth(true)).catch(() => setHealth(false)), 10000); return () => clearInterval(hb.current); }, []);

  if (terminal === undefined) return <div className="pad">Starting…</div>;
  if (!user) return <Login terminal={terminal} onLogin={setUser} health={health} />;
  if (!conf || !tab) return <div className="pad">Loading…</div>;
  const can = (p) => user.perms.includes(p);
  const status = <div className="statusbar"><span className={serverOk ? 'ok' : 'bad'}>● {serverOk ? 'SERVER CONNECTED' : 'SERVER DISCONNECTED — retrying…'}</span><span>{terminal ? terminal.code : 'no counter'}</span><span>{user.name} ({user.role})</span><span style={{ flex: 1 }} /><button onClick={() => logout()}>Logout</button></div>;
  if (tab === 'pos' || !can('dashboard.view')) return <div className="app">{can('bill.create') ? <Pos user={user} conf={conf} terminal={terminal} products={products} bus={bus} serverOk={serverOk} onExit={can('dashboard.view') ? () => setTab('dash') : null} onLogout={() => logout()} /> : <><div className="pad" style={{ flex: 1 }}>No billing permission.</div>{status}</>}</div>; // Sale Entry shows counter, operator and Logout in its own header
  const P = { user, conf, terminal, bus };
  return <div className="app"><div className="mgr"><nav className="side"><div className="brand">{conf.shop.name}</div>{NAV.filter(([, , p]) => can(p)).map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</nav>
    <main className="content">{tab === 'dash' && <Dashboard {...P} />}{tab === 'bills' && <Bills {...P} />}{tab === 'products' && <Products {...P} />}{tab === 'rates' && <div className="pad"><Card title="Rate changes — all products"><RateChanges bus={bus} products={products} /></Card></div>}{tab === 'customers' && <Customers {...P} />}{tab === 'purchases' && <Purchases {...P} />}{tab === 'stock' && <Stock {...P} />}
      {tab === 'reports' && <Reports {...P} />}{tab === 'users' && <Users {...P} />}{tab === 'terminals' && <Terminals {...P} />}{tab === 'hardware' && <Hardware {...P} />}{tab === 'settings' && <Settings {...P} />}{tab === 'backup' && <Backup {...P} />}{tab === 'audit' && <Audit {...P} />}</main></div>{status}</div>;
}
export default function App() { return <ToastHost><ApprovalHost><Shell /></ApprovalHost></ToastHost>; }
