import { useState, useEffect, useRef } from 'react';
let tok = '';
const api = async (p, o = {}) => {
  const r = await fetch('/api' + p, { ...o, body: o.body && JSON.stringify(o.body), headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok } });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Request failed'); return j;
};
const rs = p => (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qf = (u, n) => u === 'KG' ? (n / 1000).toFixed(3) + ' kg' : n + ' pcs';
const g = v => Math.round(parseFloat(v || 0) * 1000) || 0, pa = v => Math.round(parseFloat(v || 0) * 100) || 0;
const amountOf = (u, n, r) => u === 'KG' ? Math.round(n * r / 1000) : n * r;

/* ===== SHOP DETAILS – edit here, they appear on every bill ===== */
const SHOP = { name: 'Unique Basket', city: 'Rajkot', tagline: 'Fresh Fruits & Vegetables', phone: '', gstin: '', icons: true };
const ICONS = { tomato: '🍅', onion: '🧅', potato: '🥔', garlic: '🧄', lemon: '🍋', banana: '🍌', apple: '🍎', mango: '🥭', carrot: '🥕', chilli: '🌶️', grape: '🍇', orange: '🍊', cabbage: '🥬', cucumber: '🥒', brinjal: '🍆', corn: '🌽', coconut: '🥥', watermelon: '🍉', ginger: '🫚', papaya: '🍈', pineapple: '🍍', strawberry: '🍓', pomegranate: '🍎', peas: '🫛', capsicum: '🫑', beetroot: '🟣', spinach: '🥬' };
const ic = e => SHOP.icons ? e + ' ' : '';
const icon = n => SHOP.icons ? ((Object.entries(ICONS).find(([k]) => n.toLowerCase().includes(k)) || [0, '🥬'])[1] + ' ') : '';
const PAY = { CASH: '💵', UPI: '📱', CREDIT: '📒' };

function LoginCard({ role, title, hint, onLogin }) {
  const [u, setU] = useState(''), [p, setP] = useState(''), [err, setErr] = useState('');
  const go = async e => { e.preventDefault(); try { const r = await api('/login', { method: 'POST', body: { username: u, password: p, role } }); tok = r.token; onLogin(r.user); } catch (x) { setErr(x.message); } };
  return <div className="card"><h2>{title}</h2><p style={{ color: 'var(--mu)' }}>{hint}</p>
    <form onSubmit={go}><input placeholder="Username" value={u} onChange={e => setU(e.target.value)} autoFocus={role === 'OPERATOR'} />
      <input type="password" placeholder="Password" value={p} onChange={e => setP(e.target.value)} />
      <div className="msg">{err}</div><button className="b" style={{ width: '100%' }}>Login as {role === 'MANAGER' ? 'Manager' : 'Operator'}</button></form></div>;
}

function useScale(on) {
  const [s, setS] = useState({ connected: false, grams: 0, stable: false, pcs: null, error: '', mode: '' });
  useEffect(() => { if (!on) return; const es = new EventSource('/api/scale/stream?token=' + tok); es.onmessage = e => setS(JSON.parse(e.data)); es.onerror = () => setS(x => ({ ...x, connected: false, error: 'Server not reachable' })); return () => es.close(); }, [on]);
  return s;
}

function Receipt({ b }) {
  if (!b) return <div id="print" />;
  const L = { borderTop: '1px dashed #000', margin: '6px 0' }, R = { float: 'right' };
  return <div id="print" style={{ lineHeight: 1.4 }}>
    <center><div style={{ fontSize: 26 }}>{ic('🧺')}</div><b style={{ fontSize: 19 }}>{SHOP.name}</b><br />{SHOP.tagline}<br />{ic('📍')}{SHOP.city}
      {SHOP.phone && <><br />{ic('📞')}{SHOP.phone}</>}{SHOP.gstin && <><br />GSTIN: {SHOP.gstin}</>}</center><div style={L} />
    <div>{ic('🧾')}Bill No: {b.no}</div><div>{ic('📅')}{new Date(b.at).toLocaleString('en-IN')}</div>{b.customer && <div>{ic('👤')}{b.customer}</div>}
    {b.customerPhone && <div>{ic('📞')}{b.customerPhone}</div>}{b.customerAddress && <div>{ic('📍')}{b.customerAddress}</div>}<div style={L} />
    {b.items.map((i, k) => <div key={k} style={{ marginBottom: 4 }}><b>{icon(i.name)}{i.name}</b>{i.src === 'MANUAL' && ' (M)'}<br />
      &nbsp;&nbsp;{qf(i.unit, i.qty)} × ₹{rs(i.rate)}<span style={R}>₹{rs(i.amount)}</span></div>)}<div style={L} />
    <div>Subtotal<span style={R}>₹{rs(b.sub)}</span></div>{b.discount > 0 && <div>{ic('🏷️')}Discount<span style={R}>-₹{rs(b.discount)}</span></div>}
    <div style={{ fontSize: 17, marginTop: 4 }}><b>{ic('💰')}TOTAL<span style={R}>₹{rs(b.total)}</span></b></div>
    <div>{PAY[b.mode] ? PAY[b.mode] + ' ' : ''}Paid by: {b.mode}</div><div style={L} />
    <center>{ic('🙏')}Thank you! Visit again<br />{ic('🥕')}{ic('🍅')}{ic('🍋')}{ic('🍌')}</center></div>;
}

function shareBill(b) {
  const digits = String(b.customerPhone || '').replace(/\D/g, '');
  const phone = digits.length === 10 ? '91' + digits : digits.length === 11 && digits.startsWith('0') ? '91' + digits.slice(1) : digits;
  const lines = [
    `🧺 *${SHOP.name}*`,
    '🧾 *BILL RECEIPT*',
    '━━━━━━━━━━━━━━',
    `🔖 Bill No: ${b.no}`,
    `📅 ${new Date(b.at).toLocaleString('en-IN')}`,
    b.customer && `👤 Customer: ${b.customer}`,
    b.customerPhone && `📞 Phone: ${b.customerPhone}`,
    b.customerAddress && `📍 Address: ${b.customerAddress}`,
    '',
    '🛍️ *ITEMS*',
    ...b.items.map(i => `• ${i.name}  ${qf(i.unit, i.qty)} × ₹${rs(i.rate)} = *₹${rs(i.amount)}*`),
    '',
    `Subtotal: ₹${rs(b.sub)}`,
    b.discount > 0 && `🏷️ Discount: −₹${rs(b.discount)}`,
    `💰 *TOTAL: ₹${rs(b.total)}*`,
    `💳 Paid by: ${b.mode}`,
    '',
    '🙏 Thank you for your purchase!'
  ].filter(line => line !== null && line !== false);
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(lines.join('\n'))}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

function VirtualKeyboard({ onCapture, onAdd, onSave, onManual }) {
  const writeToField = key => {
    const el = document.activeElement;
    if (!(el instanceof HTMLInputElement)) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    let next = el.value;
    if (key === '⌫') next = next.slice(0, Math.max(0, start - 1)) + next.slice(end);
    else if (key === 'C') next = '';
    else next = next.slice(0, start) + key + next.slice(end);
    el.value = next;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
    const cursor = key === '⌫' ? Math.max(0, start - 1) : start + key.length;
    if (typeof el.setSelectionRange === 'function') el.setSelectionRange(cursor, cursor);
  };
  const keys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '0', '.', '⌫', 'C'];
  return <div className="keyboard-panel"><div className="keyboard-top"><strong>Desktop keyboard</strong><span>Use: C capture • A add • S save • M manual</span></div><div className="keyboard-grid">{keys.map(k => <button key={k} className="key-btn" onClick={() => writeToField(k)}>{k}</button>)}<button className="key-btn action" onClick={onCapture}>Capture</button><button className="key-btn action" onClick={onAdd}>Add</button><button className="key-btn action" onClick={onSave}>Save</button><button className="key-btn action" onClick={onManual}>Manual</button></div></div>;
}

function Billing({ user, scale, onPrint }) {
  const M = user.role === 'MANAGER';
  const [prods, setProds] = useState([]), [pid, setPid] = useState(''), [qty, setQty] = useState(0), [tare, setTare] = useState('0'), [rt, setRt] = useState(''), [src, setSrc] = useState('SCALE');
  const [items, setItems] = useState([]), [cust, setCust] = useState(''), [custPhone, setCustPhone] = useState(''), [custAddress, setCustAddress] = useState(''), [mode, setMode] = useState('CASH'), [disc, setDisc] = useState('0'), [auto, setAuto] = useState(false), [msg, setMsg] = useState(''), [busy, setBusy] = useState(false), [showKeyboard, setShowKeyboard] = useState(true);
  const p = prods.find(x => x._id === pid), rate = pa(rt), tg = g(tare), productSelectRef = useRef(null);
  useEffect(() => { api('/products').then(setProds); }, []);
  const choose = id => { const x = prods.find(z => z._id === id); setPid(id); setRt(x ? (x.rate / 100).toFixed(2) : ''); setQty(0); setSrc('SCALE'); };
  const nextProduct = () => {
    if (!prods.length) return;
    const active = prods.filter(x => x.active);
    if (!active.length) return;
    const idx = active.findIndex(x => x._id === pid);
    const next = active[(idx + 1 + active.length) % active.length];
    choose(next._id);
  };
  const capture = () => {
    if (!p) return setMsg('Select a product first'); if (!scale.connected) return setMsg('Scale disconnected' + (M ? ' – use Manual Weight' : ' – call manager')); if (scale.error) return setMsg(scale.error);
    if (p.unit === 'KG') { if (!scale.stable) return setMsg('Weight unstable – wait'); const n = scale.grams - tg; if (n <= 0) return setMsg('Net weight must be positive'); setQty(n); }
    else { const n = scale.pcs != null ? scale.pcs : p.unitWeight ? Math.round((scale.grams - tg) / p.unitWeight) : 0; if (n <= 0) return setMsg('Cannot count pieces – type the quantity'); setQty(n); }
    setSrc('SCALE'); setMsg('');
  };
  const manual = () => { if (!M) return setMsg('Manual weight needs manager login'); if (p?.unit !== 'KG') return; const v = prompt('Manual weight (kg)'); if (v && g(v) > 0) { setQty(g(v)); setSrc('MANUAL'); } };
  const add = (n = qty, s = src) => { if (!p || !(n > 0)) return setMsg('Capture weight / enter quantity first'); if (!(rate > 0)) return setMsg('Rate missing'); setItems(a => [...a, { productId: p._id, name: p.name, unit: p.unit, qty: n, rate, amount: amountOf(p.unit, n, rate), src: s }]); setQty(0); setMsg(''); };
  const updateItemQty = (idx, raw) => setItems(a => a.map((i, k) => {
    if (k !== idx) return i;
    const value = i.unit === 'KG' ? (parseFloat(raw || 0) > 0 ? g(raw) : 0) : (Math.round(Number(raw || 0)) || 0);
    return value > 0 ? { ...i, qty: value, amount: amountOf(i.unit, value, i.rate) } : { ...i, qty: 0, amount: 0 };
  }));
  const armed = useRef(true), fn = useRef({});
  const sub = items.reduce((s, i) => s + i.amount, 0), d = Math.min(pa(disc), sub), total = Math.round((sub - d) / 100) * 100;
  const save = async () => {
    if (busy) return; if (!items.length) return setMsg('Add at least one item'); setBusy(true);
    try { const b = await api('/bills', { method: 'POST', body: { items, customer: cust, customerPhone: custPhone, customerAddress: custAddress, mode, discount: d } }); setItems([]); setCust(''); setCustPhone(''); setCustAddress(''); setDisc('0'); setMsg('Saved ' + b.no); api('/products').then(setProds); onPrint(b); shareBill(b); }
    catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };
  fn.current = { capture, add, save, manual, nextProduct, focusProduct: () => productSelectRef.current?.focus() };
  // DIRECT / AUTO CAPTURE: when stable weight appears, item is added automatically; re-arms when scale returns to empty
  useEffect(() => {
    if (scale.grams < 50) { armed.current = true; return; }
    if (!auto || !armed.current || !p || p.unit !== 'KG' || !scale.stable || !scale.connected) return;
    const n = scale.grams - tg; if (n > 0 && rate > 0) { armed.current = false; fn.current.add(n, 'SCALE'); }
  }, [scale, auto, pid]);
  useEffect(() => {
    const k = e => {
      const tag = e.target && e.target.tagName;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
      const key = e.key.toLowerCase();
      const m = { F4: 'capture', F5: 'add', F6: 'save', c: 'capture', a: 'add', s: 'save', m: 'manual', n: 'nextProduct', p: 'focusProduct' }[e.key] || { F4: 'capture', F5: 'add', F6: 'save', c: 'capture', a: 'add', s: 'save', m: 'manual', n: 'nextProduct', p: 'focusProduct' }[key];
      if (m) { e.preventDefault(); fn.current[m](); }
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, []);
  return <div className="grid2"><div>
    <div className="card"><h3>Weighing scale · {scale.connected ? <b className="ok">Connected ({scale.mode})</b> : <b className="bad">Disconnected</b>}</h3>
      <div className="live">{scale.connected ? (scale.grams / 1000).toFixed(3) : '--'} <small>KG</small></div>
      {scale.pcs != null && <div className="st">Count: {scale.pcs} pcs</div>}
      <div className="st">{scale.error ? <span className="bad">{scale.error}</span> : scale.stable ? <span className="ok">STABLE ✓</span> : <span className="bad">UNSTABLE…</span>}</div></div>
    <div className="card"><h3>Item</h3><div className="row">
      <label>Product<select ref={productSelectRef} value={pid} onChange={e => choose(e.target.value)}><option value="">Select…</option>{prods.filter(x => x.active).map(x => <option key={x._id} value={x._id}>{x.name} ({x.unit})</option>)}</select></label>
      <label>Tare kg<input value={tare} onChange={e => setTare(e.target.value)} /></label>
      <label>{p?.unit === 'PCS' ? 'Pieces' : 'Net kg'}{p?.unit === 'PCS' ? <input value={qty || ''} onChange={e => { setQty(Math.round(+e.target.value) || 0); setSrc('SCALE'); }} /> : <input readOnly value={qty ? (qty / 1000).toFixed(3) : ''} />}</label>
      <label>Rate ₹{p ? '/' + p.unit.toLowerCase() : ''}<input value={rt} readOnly={!M} onChange={e => setRt(e.target.value)} /></label>
      <label>Amount ₹<input readOnly value={p && qty ? rs(amountOf(p.unit, qty, rate)) : ''} /></label></div>
      {p && <div style={{ color: 'var(--mu)', marginBottom: 6 }}>Stock: {qf(p.unit, p.stock)}</div>}
      <div className="billing-actions"><button className="b" onClick={capture}>Capture (F4 / C)</button> <button className="b" onClick={() => add()}>Add Item (F5 / A)</button> <button onClick={manual}>Manual Weight (M)</button> <button onClick={() => setShowKeyboard(v => !v)}>{showKeyboard ? 'Hide keyboard' : 'Show keyboard'}</button></div>
      <label style={{ display: 'inline-block', marginLeft: 10 }}><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} style={{ width: 'auto', height: 'auto' }} /> Auto-capture (KG)</label>
      <div className="msg">{msg}</div></div>
      {showKeyboard && <VirtualKeyboard onCapture={capture} onAdd={() => add()} onSave={save} onManual={manual} />}
    </div>
    <div><div className="card"><h3>Bill items</h3><table><thead><tr><th>Product</th><th className="n">Qty</th><th className="n">Rate</th><th className="n">Amount</th><th></th></tr></thead><tbody>
      {items.map((i, k) => <tr key={k}><td>{i.name} {i.src === 'MANUAL' && <span className="tag">MANUAL</span>}</td><td className="n">{i.unit === 'KG'
        ? <input value={i.qty ? (i.qty / 1000).toFixed(3) : ''} onChange={e => updateItemQty(k, e.target.value)} style={{ width: 72 }} />
        : <input value={i.qty} onChange={e => updateItemQty(k, e.target.value)} style={{ width: 60 }} />}</td><td className="n">{rs(i.rate)}</td><td className="n">{rs(i.amount)}</td><td><button className="d" onClick={() => setItems(items.filter((_, j) => j !== k))}>✕</button></td></tr>)}
      {!items.length && <tr><td colSpan="5" style={{ color: 'var(--mu)' }}>No items yet</td></tr>}</tbody></table></div>
    <div className="card"><h3>Payment</h3><div className="row"><label>Customer name<input value={cust} onChange={e => setCust(e.target.value)} placeholder="Walk-in" /></label>
      <label>Phone / WhatsApp<input type="tel" value={custPhone} onChange={e => setCustPhone(e.target.value)} placeholder="Mobile number" /></label>
      <label>Address<input value={custAddress} onChange={e => setCustAddress(e.target.value)} placeholder="Customer address" /></label>
      <label>Payment<select value={mode} onChange={e => setMode(e.target.value)}><option>CASH</option><option>UPI</option><option>CREDIT</option></select></label>
      <label>Discount ₹<input value={disc} onChange={e => setDisc(e.target.value)} /></label></div>
      <div className="tot"><span>Subtotal</span><span>₹{rs(sub)}</span></div><div className="tot"><span>Discount</span><span>−₹{rs(d)}</span></div><div className="tot gt"><span>Total</span><span>₹{rs(total)}</span></div>
      <button className="b" disabled={busy} onClick={save} style={{ width: '100%', marginTop: 10, height: 44 }}>🧾 Save, Print & WhatsApp (F6)</button></div></div></div>;
}

function Products() {
  const empty = { name: '', unit: 'KG', rate: '', unitWeight: '', stock: '', code: '', active: true };
  const [list, setList] = useState([]), [f, setF] = useState(empty), [msg, setMsg] = useState('');
  const load = () => api('/products').then(setList); useEffect(() => { load(); }, []);
  const edit = p => setF({ ...p, rate: (p.rate / 100).toFixed(2), stock: p.unit === 'KG' ? (p.stock / 1000).toFixed(3) : p.stock });
  const save = async (x = f) => { try { await api('/products', { method: 'POST', body: { ...x, rate: pa(x.rate), stock: x.unit === 'KG' ? g(x.stock) : Math.round(+x.stock || 0) } }); setF(empty); setMsg('Saved'); load(); } catch (e) { setMsg(e.message); } };
  return <div className="grid2"><div className="card"><h3>Products</h3><table><thead><tr><th>Name</th><th>Unit</th><th className="n">Rate</th><th className="n">Stock</th><th></th></tr></thead><tbody>
    {list.map(p => <tr key={p._id} style={{ opacity: p.active ? 1 : .5 }}><td>{p.name}</td><td>{p.unit}</td><td className="n">{rs(p.rate)}</td><td className="n">{qf(p.unit, p.stock)}</td>
      <td><button onClick={() => edit(p)}>Edit</button> <button className="d" onClick={() => { const x = { ...p, rate: (p.rate / 100).toFixed(2), stock: p.unit === 'KG' ? (p.stock / 1000).toFixed(3) : p.stock, active: !p.active }; save(x); }}>{p.active ? 'Disable' : 'Enable'}</button></td></tr>)}</tbody></table></div>
    <div className="card"><h3>{f._id ? 'Edit product' : 'Add product'}</h3><div className="row">
      <label>Name<input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></label>
      <label>Unit<select value={f.unit} onChange={e => setF({ ...f, unit: e.target.value })}><option value="KG">KG (weighed)</option><option value="PCS">PCS (counted)</option></select></label>
      <label>Rate ₹ per {f.unit === 'KG' ? 'kg' : 'piece'}<input value={f.rate} onChange={e => setF({ ...f, rate: e.target.value })} /></label>
      <label>Stock ({f.unit === 'KG' ? 'kg' : 'pcs'})<input value={f.stock} onChange={e => setF({ ...f, stock: e.target.value })} /></label>
      {f.unit === 'PCS' && <label>Weight of 1 piece (grams) – for counting on scale<input value={f.unitWeight} onChange={e => setF({ ...f, unitWeight: e.target.value })} /></label>}
      <label>Code / barcode<input value={f.code} onChange={e => setF({ ...f, code: e.target.value })} /></label></div>
      <button className="b" onClick={() => save()}>Save product</button> {f._id && <button onClick={() => setF(empty)}>Cancel</button>}<div className="msg">{msg}</div></div></div>;
}

function Bills({ user, onPrint }) {
  const M = user.role === 'MANAGER';
  const today = new Date().toISOString().slice(0, 10);
  const [viewMode, setViewMode] = useState('ALL');
  const [d, setD] = useState(today), [fromDate, setFromDate] = useState(''), [toDate, setToDate] = useState(''), [bills, setBills] = useState([]), [sm, setSm] = useState(null);
  const effectiveFrom = fromDate && toDate && fromDate > toDate ? toDate : fromDate;
  const effectiveTo = fromDate && toDate && fromDate > toDate ? fromDate : toDate;
  const buildQuery = () => {
    const q = new URLSearchParams();
    if (viewMode === 'DATE') q.set('date', d);
    if (viewMode === 'RANGE') {
      if (effectiveFrom) q.set('from', effectiveFrom);
      if (effectiveTo) q.set('to', effectiveTo);
    }
    return q.toString();
  };
  const load = () => {
    const q = buildQuery();
    const s = q ? ('?' + q) : '';
    api('/bills' + s).then(setBills);
    if (M) api('/summary' + s).then(setSm).catch(() => setSm(null));
  };
  useEffect(() => { load(); }, [viewMode, d, effectiveFrom, effectiveTo]);
  const cancel = async b => { const r = prompt('Reason for cancelling'); if (!r) return; try { await api(`/bills/${b._id}/cancel`, { method: 'POST', body: { reason: r } }); load(); } catch (e) { alert(e.message); } };
  return <div>{sm && <div className="cards">{[['Sales', '₹' + rs(sm.sales)], ['Bills', sm.bills], ['Kg sold', (sm.kg / 1000).toFixed(3)], ['Cash', '₹' + rs(sm.CASH)], ['UPI', '₹' + rs(sm.UPI)], ['Credit', '₹' + rs(sm.CREDIT)]].map(([a, b]) => <div className="k" key={a}><small>{a}</small><div>{b}</div></div>)}</div>}
    <div className="card"><h3>Bills</h3>
      <div className="row" style={{ marginBottom: 10 }}>
        <label>View<select value={viewMode} onChange={e => setViewMode(e.target.value)}><option value="ALL">All bills</option><option value="DATE">Selected date</option><option value="RANGE">Date range</option></select></label>
        {viewMode === 'DATE' && <label>Date<input type="date" max={today} value={d} onChange={e => setD(e.target.value)} /></label>}
        {viewMode === 'RANGE' && <><label>From<input type="date" max={today} value={fromDate} onChange={e => setFromDate(e.target.value)} /></label><label>To<input type="date" max={today} value={toDate} onChange={e => setToDate(e.target.value)} /></label></>}
      </div>
      <table><thead><tr><th>No</th><th>Counter</th><th>Customer</th><th>Items</th><th>Mode</th><th className="n">Total</th><th>Status</th><th></th></tr></thead><tbody>
      {bills.map(b => <tr key={b._id}><td>{b.no}</td><td>{b.counter || '-'}</td><td>{b.customer || 'Walk-in'}</td><td>{b.items.map(i => i.name).join(', ')}</td><td>{b.mode}</td><td className="n">₹{rs(b.total)}</td><td>{b.status}</td>
        <td><button onClick={() => onPrint(b)}>Reprint</button> <button onClick={() => shareBill(b)}>WhatsApp</button> {M && b.status === 'COMPLETED' && <button className="d" onClick={() => cancel(b)}>Cancel</button>}</td></tr>)}
      {!bills.length && <tr><td colSpan="8" style={{ color: 'var(--mu)' }}>No bills</td></tr>}</tbody></table></div></div>;
}

function Users() {
  const [list, setList] = useState([]), [f, setF] = useState({ username: '', password: '', role: 'OPERATOR', name: '' }), [msg, setMsg] = useState('');
  const load = () => api('/users').then(setList); useEffect(() => { load(); }, []);
  const add = async () => { try { await api('/users', { method: 'POST', body: f }); setF({ username: '', password: '', role: 'OPERATOR', name: '' }); setMsg('User created'); load(); } catch (e) { setMsg(e.message); } };
  return <div className="grid2"><div className="card"><h3>Users</h3><table><tbody>{list.map(u => <tr key={u._id}><td>{u.username}</td><td>{u.role}</td><td>{u.active ? 'Active' : 'Disabled'}</td><td><button onClick={() => api(`/users/${u._id}/toggle`, { method: 'POST' }).then(load).catch(e => setMsg(e.message))}>{u.active ? 'Disable' : 'Enable'}</button></td></tr>)}</tbody></table></div>
    <div className="card"><h3>Add user</h3><div className="row"><label>Name<input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></label><label>Username<input value={f.username} onChange={e => setF({ ...f, username: e.target.value })} /></label>
      <label>Password (min 6)<input type="password" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} /></label><label>Role<select value={f.role} onChange={e => setF({ ...f, role: e.target.value })}><option>OPERATOR</option><option>MANAGER</option></select></label></div>
      <button className="b" onClick={add}>Create user</button><div className="msg">{msg}</div></div></div>;
}

function ScaleSettings({ scale }) {
  const [c, setC] = useState(null), [ports, setPorts] = useState([]), [msg, setMsg] = useState(''), [w, setW] = useState('24.650'), [st, setSt] = useState(true), [pc, setPc] = useState('');
  useEffect(() => { api('/scale/config').then(r => setC(r.cfg)); api('/scale/ports').then(setPorts).catch(() => { }); }, []);
  if (!c) return null;
  const set = (k, v) => setC({ ...c, [k]: v });
  const save = async () => { try { await api('/scale/config', { method: 'POST', body: c }); setMsg('Saved. Connecting…'); } catch (e) { setMsg(e.message); } };
  const sim = (x = w, s = st) => api('/scale/mock', { method: 'POST', body: { grams: g(x), stable: s, pcs: pc === '' ? null : +pc } }).catch(e => setMsg(e.message));
  return <div className="grid2"><div className="card"><h3>Scale connection · {scale.connected ? <b className="ok">Connected</b> : <b className="bad">Disconnected</b>} {scale.error && <span className="bad"> {scale.error}</span>}</h3>
    <div className="row"><label>Mode<select value={c.mode} onChange={e => set('mode', e.target.value)}><option value="mock">Mock / simulator</option><option value="serial">Serial (RS-232 / USB)</option></select></label>
      <label>COM port<input list="ports" value={c.path} onChange={e => set('path', e.target.value)} placeholder="COM3" /><datalist id="ports">{ports.map(p => <option key={p.path} value={p.path}>{p.name}</option>)}</datalist></label>
      <label>Baud rate<input value={c.baudRate} onChange={e => set('baudRate', e.target.value)} /></label><label>Data bits<select value={c.dataBits} onChange={e => set('dataBits', e.target.value)}><option>8</option><option>7</option></select></label>
      <label>Stop bits<select value={c.stopBits} onChange={e => set('stopBits', e.target.value)}><option>1</option><option>2</option></select></label><label>Parity<select value={c.parity} onChange={e => set('parity', e.target.value)}><option>none</option><option>even</option><option>odd</option></select></label></div>
    <button className="b" onClick={save}>Save & Connect</button><div className="msg">{msg}</div></div>
    <div className="card"><h3>Simulator (mock mode)</h3><div className="row"><label>Weight kg<input value={w} onChange={e => setW(e.target.value)} /></label><label>Pieces (optional)<input value={pc} onChange={e => setPc(e.target.value)} /></label></div>
      <label style={{ marginBottom: 8 }}><input type="checkbox" checked={st} onChange={e => setSt(e.target.checked)} style={{ width: 'auto', height: 'auto' }} /> Stable</label>
      <button className="b" onClick={() => sim()}>Set</button> {['0', '10.250', '24.650', '50'].map(v => <button key={v} onClick={() => { setW(v); sim(v); }}>{v}</button>)}</div></div>;
}

export default function App() {
  const [user, setUser] = useState(null), [tab, setTab] = useState('billing'), [pb, setPb] = useState(null), scale = useScale(!!user);
  const onPrint = b => { setPb(b); setTimeout(() => { try { window.print(); } catch (e) { alert('Invoice saved. Printer unavailable.'); } }, 150); };
  if (!user) return <div className="login"><LoginCard role="MANAGER" title="Manager Login" hint="Rates, products, users, reports, scale setup" onLogin={u => { setUser(u); setTab('billing'); }} /><LoginCard role="OPERATOR" title="Operator Login" hint="Counter billing only" onLogin={u => { setUser(u); setTab('billing'); }} /></div>;
  const M = user.role === 'MANAGER', tabs = M ? [['billing', 'Billing'], ['bills', 'Bills & Reports'], ['products', 'Products'], ['users', 'Users'], ['scale', 'Scale']] : [['billing', 'Billing'], ['bills', 'My Bills']];
  return <><header><b>🧺 {SHOP.name} · {SHOP.city}</b><div className="tabs">{tabs.map(([k, v]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{v}</button>)}</div><span style={{ flex: 1 }} />
    <span>{user.name} ({user.role})</span><button onClick={() => { tok = ''; setUser(null); }}>Logout</button></header>
    <main>{tab === 'billing' && <Billing user={user} scale={scale} onPrint={onPrint} />}{tab === 'bills' && <Bills user={user} onPrint={onPrint} />}{tab === 'products' && <Products />}{tab === 'users' && <Users />}{tab === 'scale' && <ScaleSettings scale={scale} />}</main><Receipt b={pb} /></>;
}
