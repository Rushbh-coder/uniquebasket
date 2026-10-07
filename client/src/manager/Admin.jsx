/** Reports, Users, Terminals, Hardware (scale + printer), Settings, Backup, Audit, Shifts. */
import { useEffect, useState } from 'react';
import { get, post, put, download } from '../lib/api';
import { rs, dt, today, paise, pct } from '../lib/fmt';
import { receiptHtml, printHtml, openBillsFolder } from '../lib/print';
import { ACTIONS, keysOf } from '../lib/shortcuts';
import { Table, Card, DateRange } from './common';
import { Field, Msg, Modal, useToast } from '../components/ui';

const REPORTS = [['daily', 'Daily / date-wise sales'], ['product', 'Product-wise'], ['category', 'Category-wise'], ['operator', 'Operator-wise'], ['counter', 'Counter-wise'], ['customer', 'Customer-wise'], ['payment', 'Payment-mode summary'], ['credit', 'Credit sales'], ['outstanding', 'Outstanding customers'], ['gst', 'GST / tax summary'], ['discount', 'Discounts'], ['cancelled', 'Cancelled bills'], ['returns', 'Returns'], ['prices', 'Price changes'], ['purchases', 'Purchases'], ['suppliers', 'Supplier payables'], ['stock', 'Stock'], ['lowstock', 'Low stock'], ['wastage', 'Wastage'], ['shifts', 'Cash shifts'], ['profit', 'Profit / margin (owner)']];
const MONEY = /^(sales|amount|discount|tax|cash|upi|card|credit|total|paid|balance|creditLimit|payable|sub|old|rate|taxable|cgst|sgst|cost|margin|opening|expected|actual|difference)$/;
export function Reports({ user }) {
  const [name, setName] = useState('daily'), [r, setR] = useState({ from: today(), to: today() }), [f, setF] = useState({ terminal: '', by: '' }), [rows, setRows] = useState(null), [err, setErr] = useState('');
  const qs = () => new URLSearchParams({ ...r, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) }).toString();
  const run = () => { setErr(''); setRows(null); get(`/reports/${name}?${qs()}`).then(setRows).catch((e) => { setErr(e.message); setRows([]); }); };
  useEffect(run, [name, r]);
  const cols = rows && rows.length ? Object.keys(rows.reduce((a, x) => Object.assign(a, x), {})).map((k) => [k, (x) => (typeof x[k] === 'boolean' ? (x[k] ? 'yes' : '') : k === 'at' || k === 'opened' || k === 'closed' ? dt(x[k]) : x[k]), MONEY.test(k) ? { money: 1 } : typeof rows[0][k] === 'number' ? { n: 1 } : {}]) : [['', () => '']];
  const sums = rows && rows.length ? Object.keys(rows[0]).filter((k) => MONEY.test(k)).map((k) => `${k}: ₹${rs(rows.reduce((s, x) => s + (x[k] || 0), 0))}`) : [];
  return <div className="pad">
    <Card title="Reports" right={<span className="acts"><select value={name} onChange={(e) => setName(e.target.value)}>{REPORTS.filter(([k]) => k !== 'profit' || user.perms.includes('report.profit')).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      <DateRange value={r} onChange={setR} /><input placeholder="Counter" value={f.terminal} onChange={(e) => setF({ ...f, terminal: e.target.value })} style={{ width: 100 }} /><input placeholder="Operator" value={f.by} onChange={(e) => setF({ ...f, by: e.target.value })} style={{ width: 100 }} />
      <button onClick={run}>Run</button><button onClick={() => download(`/reports/${name}?${qs()}&format=csv`, `${name}-${r.from}.csv`)}>Excel/CSV</button><button onClick={() => window.print()}>Print</button></span>}>
      <Msg m={err} />{sums.length > 0 && <div className="mut">Totals — {sums.join(' · ')}</div>}<div className="printable"><Table cols={cols} rows={rows} /></div></Card></div>;
}

export function Users({ user }) {
  const toast = useToast(); const ROLES = ['OPERATOR', 'MANAGER', 'OWNER', 'ACCOUNTANT', 'STOCK_MANAGER', 'PURCHASE_MANAGER', 'SUPER_ADMIN'];
  const [list, setList] = useState(null), [f, setF] = useState(null), [err, setErr] = useState(''), [sess, setSess] = useState(null);
  const load = () => { get('/users').then(setList); get('/sessions').then(setSess).catch(() => {}); };
  useEffect(() => { load(); }, []);
  const save = async () => { setErr(''); try { if (f._id) await put('/users/' + f._id, { name: f.name, role: f.role, active: f.active, password: f.password || undefined, pin: f.pin || undefined, unlock: f.unlock }); else await post('/users', f); toast('User saved', 'ok'); setF(null); load(); } catch (e) { setErr(e.message); } };
  return <div className="pad cols2w">
    <Card title="Users" right={<button className="b" onClick={() => setF({ username: '', name: '', role: 'OPERATOR', password: '', pin: '' })}>+ Add user</button>}>
      <Table cols={[['Username', 'username'], ['Name', 'name'], ['Role', 'role'], ['PIN', (u) => (u.hasPin ? 'yes' : '')], ['Status', (u) => (u.locked ? 'LOCKED' : u.active ? 'Active' : 'Disabled')]]} rows={list} onRow={(u) => setF({ ...u, password: '', pin: '' })} sel={f?._id} /></Card>
    <div>{f && <Card title={f._id ? `Edit ${f.username}` : 'New user'}><div className="form2">
      {!f._id && <Field label="Username"><input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>}
      <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Role"><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></Field>
      <Field label={f._id ? 'New password (blank = keep)' : 'Password (8+, letters & numbers)'}><input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
      <Field label="PIN 4-6 digits (fast login & approvals)"><input type="password" value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value })} /></Field>
      {f._id && <label className="chk"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>}
      {f.locked && <label className="chk"><input type="checkbox" checked={!!f.unlock} onChange={(e) => setF({ ...f, unlock: e.target.checked })} /> Unlock</label>}</div>
      <Msg m={err} /><div className="row-r"><button onClick={() => setF(null)}>Cancel</button><button className="b" onClick={save}>Save</button></div></Card>}
      <Card title="Login history"><Table cols={[['User', 'username'], ['Terminal', 'terminalCode'], ['Login', (s) => dt(s.loginAt)], ['Logout', (s) => dt(s.logoutAt)], ['Active', (s) => (s.active ? 'yes' : '')]]} rows={sess} max={50} /></Card></div>
  </div>;
}

export function Terminals({ bus }) {
  const toast = useToast();
  const [list, setList] = useState(null), [f, setF] = useState(null), [code, setCode] = useState(null), [err, setErr] = useState('');
  const load = () => get('/terminals').then(setList);
  useEffect(() => { load(); const o = [bus.on('terminal:online', load), bus.on('terminal:offline', load)]; const t = setInterval(load, 30000); return () => { o.forEach((x) => x()); clearInterval(t); }; }, []);
  const save = async () => { setErr(''); try { if (f._id) await put('/terminals/' + f._id, f); else { const r = await post('/terminals', f); setCode({ t: r.terminal, c: r.enrolCode }); } setF(null); load(); } catch (e) { setErr(e.message); } };
  return <div className="pad cols2w">
    <Card title="Counters / terminals" right={<button className="b" onClick={() => setF({ code: 'COUNTER-0' + ((list || []).length), name: '', series: 'C' + ((list || []).length), active: true, print: { paper: '80mm', copies: 1, printer: '' } })}>+ Add counter</button>}>
      <Table cols={[['Terminal ID', (t) => <b>{t.code}</b>], ['Name', 'name'], ['Series', 'series'], ['Status', (t) => <span className={t.status === 'ONLINE' ? 'ok' : 'bad'}>{t.status}</span>], ['Last seen', (t) => dt(t.lastSeen)], ['Operator', 'currentUser'], ['Machine / IP', (t) => [t.machine, t.ip].filter(Boolean).join(' ')], ['Scale', 'scaleStatus'], ['Version', 'version'], ['Enrolled', (t) => (t.enrolled ? 'yes' : 'NO')]]} rows={list} onRow={(t) => setF({ ...t, print: t.print || { paper: '80mm', copies: 1, printer: '' } })} sel={f?._id} /></Card>
    {f && <Card title={f._id ? `Edit ${f.code}` : 'New counter'}><div className="form2">
      {!f._id && <Field label="Terminal ID"><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>}
      <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Bill series (C1, C2…)"><input value={f.series} onChange={(e) => setF({ ...f, series: e.target.value.toUpperCase() })} /></Field>
      <Field label="Paper"><select value={f.print.paper} onChange={(e) => setF({ ...f, print: { ...f.print, paper: e.target.value } })}>{['58mm', '80mm', 'A4'].map((x) => <option key={x}>{x}</option>)}</select></Field>
      <Field label="Printer name (blank = Windows default)"><input value={f.print.printer} onChange={(e) => setF({ ...f, print: { ...f.print, printer: e.target.value } })} /></Field>
      <Field label="Copies"><input value={f.print.copies} onChange={(e) => setF({ ...f, print: { ...f.print, copies: +e.target.value || 1 } })} /></Field>
      {f._id && <label className="chk"><input type="checkbox" checked={f.active !== false} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>}</div>
      <Msg m={err} /><div className="row-r">{f._id && !f.local && <button onClick={async () => { const r = await post(`/terminals/${f._id}/enrol-code`); setCode({ t: f, c: r.enrolCode }); load(); }}>New enrolment code</button>}<button onClick={() => setF(null)}>Cancel</button><button className="b" onClick={save}>Save</button></div></Card>}
    {code && <Modal title={`Enrol ${code.t.code}`} onClose={() => setCode(null)} width={420}><p>On the counter PC choose <b>Counter PC</b> in PC Setup and enter:</p><div className="bigcode">{code.c}</div><p className="mut">Valid 7 days, single use. Server address: this PC's IP, port 4310.</p></Modal>}
  </div>;
}

export function Hardware({ conf, terminal }) {
  const toast = useToast();
  const [c, setC] = useState(null), [ports, setPorts] = useState([]), [sample, setSample] = useState('ST,GS,+018.450kg'), [parsed, setParsed] = useState(null), [err, setErr] = useState(''), [printers, setPrinters] = useState([]), [sim, setSim] = useState('18.450');
  const load = () => get('/scale/config').then((r) => setC(r)).catch((e) => setErr(e.message));
  useEffect(() => { load(); get('/scale/ports').then(setPorts).catch(() => {}); window.pos?.printers?.().then(setPrinters).catch(() => {}); const t = setInterval(load, 3000); return () => clearInterval(t); }, []);
  if (!c) return <div className="pad">{err || 'Loading…'}</div>;
  const cfg = c.cfg, set = (k, v) => setC({ ...c, cfg: { ...cfg, [k]: v } });
  const save = async () => { setErr(''); try { await post('/scale/config', cfg); toast('Scale settings saved for this PC', 'ok'); load(); } catch (e) { setErr(e.message); } };
  const testPrint = async () => { try { const b = { no: 'TEST-PRINT', at: new Date().toISOString(), terminalCode: terminal?.code, by: 'test', items: [{ name: 'Tomato', unit: 'KG', qty: 18450, rate: 3200, amount: 59040 }], sub: 59040, discount: 0, tax: 0, roundOff: -40, total: 59000, payments: [{ mode: 'CASH', amount: 59000 }] }; await printHtml(receiptHtml(b, conf.shop, { paper: terminal?.print?.paper || conf.print.paper }), { printer: terminal?.print?.printer, silent: conf.print.silent, paper: terminal?.print?.paper || conf.print.paper, save: conf.print.saveCopy, fileName: 'TEST-PRINT' }); toast(conf.print.saveCopy === 'SAVE_ONLY' ? 'Saved as PDF on this PC' : 'Sent to printer', 'ok'); } catch (e) { toast(e.message, 'error'); } };
  const s = c.status;
  return <div className="pad cols2">
    <Card title={`Weighing scale (this PC) — ${s.connected ? 'CONNECTED' : 'DISCONNECTED'}`} right={<b>{(s.grams / 1000).toFixed(3)} kg {s.stable ? 'STABLE' : ''}</b>}>
      <div className="form2">
        <Field label="Connection"><select value={cfg.transport} onChange={(e) => set('transport', e.target.value)}><option value="serial">Serial (RS-232 / USB-serial)</option><option value="mock">Simulator (testing)</option></select></Field>
        <Field label="COM port"><input list="ports" value={cfg.path} onChange={(e) => set('path', e.target.value)} placeholder="COM3" /><datalist id="ports">{ports.map((p) => <option key={p.path} value={p.path}>{p.name}</option>)}</datalist></Field>
        <Field label="Baud"><select value={cfg.baudRate} onChange={(e) => set('baudRate', +e.target.value)}>{[1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].map((x) => <option key={x}>{x}</option>)}</select></Field>
        <Field label="Data bits"><select value={cfg.dataBits} onChange={(e) => set('dataBits', +e.target.value)}><option>8</option><option>7</option></select></Field>
        <Field label="Stop bits"><select value={cfg.stopBits} onChange={(e) => set('stopBits', +e.target.value)}><option>1</option><option>2</option></select></Field>
        <Field label="Parity"><select value={cfg.parity} onChange={(e) => set('parity', e.target.value)}>{['none', 'even', 'odd'].map((x) => <option key={x}>{x}</option>)}</select></Field>
        <Field label="Protocol / format"><select value={cfg.protocol} onChange={(e) => set('protocol', e.target.value)}>{c.protocols.map((x) => <option key={x}>{x}</option>)}</select></Field>
        <Field label="Line end"><select value={cfg.lineEnd} onChange={(e) => set('lineEnd', e.target.value)}><option>LF</option><option>CR</option></select></Field>
        {cfg.protocol === 'regex' && <Field label="Pattern (group 1 = weight)"><input value={cfg.pattern} onChange={(e) => set('pattern', e.target.value)} /></Field>}
        <Field label="Stable after N equal readings"><input value={cfg.stableCount} onChange={(e) => set('stableCount', e.target.value)} /></Field>
        <Field label="Request command (only polled scales)"><input value={cfg.requestCmd} onChange={(e) => set('requestCmd', e.target.value)} placeholder="e.g. W\r" /></Field></div>
      <Msg m={err || s.error} /><div className="row-r"><button onClick={() => post('/scale/disconnect').then(load)}>Disconnect</button><button onClick={() => post('/scale/connect').then(load)}>Connect</button><button className="b" onClick={save}>Save & connect</button></div>
      <div className="mut">Last raw lines from scale:</div><pre className="raw">{(c.lastLines || []).join('\n') || '(none yet)'}</pre>
      <Field label="TEST: paste sample output from your scale"><textarea rows={2} value={sample} onChange={(e) => setSample(e.target.value)} /></Field>
      <button onClick={async () => setParsed(await post('/scale/test-parse', { protocol: cfg.protocol, sample, pattern: cfg.pattern }))}>Test format</button>
      {parsed && <pre className="raw">{parsed.map((x) => `${x.line}  →  ${JSON.stringify(x.result)}`).join('\n')}</pre>}
      {cfg.transport === 'mock' && <div className="row-r" style={{ justifyContent: 'flex-start' }}><input value={sim} onChange={(e) => setSim(e.target.value)} style={{ width: 90 }} /><button onClick={() => post('/scale/simulate', { grams: Math.round(parseFloat(sim) * 1000), stable: true })}>Simulate weight</button><button onClick={() => post('/scale/simulate', { grams: 0 })}>Empty</button></div>}
    </Card>
    <Card title="Printer (this counter)"><div className="kv"><span>Paper</span><b>{terminal?.print?.paper || conf.print.paper}</b><span>Printer</span><b>{terminal?.print?.printer || 'Windows default'}</b><span>Copies</span><b>{terminal?.print?.copies || 1}</b><span>Silent</span><b>{conf.print.silent ? 'yes' : 'no'}</b></div>
      {printers.length > 0 && <><div className="mut">Printers on this PC:</div><ul>{printers.map((p) => <li key={p.name}>{p.name}{p.isDefault ? ' (default)' : ''}</li>)}</ul></>}
      <div className="mut">Set printer and paper per counter in Counters.</div><button className="b" onClick={testPrint}>Test print</button></Card>
  </div>;
}

export function Settings() {
  const toast = useToast(); const [s, setS] = useState(null), [err, setErr] = useState('');
  useEffect(() => { get('/settings').then(setS); }, []);
  if (!s) return <div className="pad">Loading…</div>;
  const B = s.billing, set = (sec, k, v) => setS({ ...s, [sec]: { ...s[sec], [k]: v } });
  const save = async () => { setErr(''); try { setS(await put('/settings', { shop: s.shop, billing: B, discountLimits: s.discountLimits, print: s.print, shortcuts: s.shortcuts, backup: s.backup })); toast('Settings saved — counters updated', 'ok'); } catch (e) { setErr(e.message); } };
  const chk = (k, label) => <label className="chk"><input type="checkbox" checked={!!B[k]} onChange={(e) => set('billing', k, e.target.checked)} /> {label}</label>;
  return <div className="pad cols2">
    <Card title="Shop information"><div className="form2">{['name', 'tagline', 'address', 'city', 'state', 'phone', 'gstin', 'footer'].map((k) => <Field key={k} label={k}><input value={s.shop[k] || ''} onChange={(e) => set('shop', k, k === 'gstin' ? e.target.value.toUpperCase() : e.target.value)} /></Field>)}</div></Card>
    <Card title="Billing / invoice / tax"><div className="form2">
      <Field label="Invoice prefix"><input value={B.invoicePrefix} onChange={(e) => set('billing', 'invoicePrefix', e.target.value.toUpperCase())} /></Field>
      <Field label="Numbering"><select value={B.numbering} onChange={(e) => set('billing', 'numbering', e.target.value)}><option value="COUNTER">Per counter (INV/26-27/C1-000001)</option><option value="GLOBAL">One series (INV/26-27/000001)</option></select></Field>
      <Field label="Round grand total to"><select value={B.roundStep} onChange={(e) => set('billing', 'roundStep', +e.target.value)}><option value={1}>no rounding</option><option value={10}>₹0.10</option><option value={50}>₹0.50</option><option value={100}>₹1</option></select></Field>
      <Field label="Credit limit exceeded"><select value={B.creditPolicy} onChange={(e) => set('billing', 'creditPolicy', e.target.value)}><option value="BLOCK">Block (manager PIN)</option><option value="WARN">Warn only</option></select></Field>
      {chk('priceIncludesTax', 'Rates include GST')}{chk('allowNegativeStock', 'Allow sale when stock is 0')}{chk('operatorApprovals', 'Operators need a manager PIN for manual weight, rate change, big discount, credit over limit')}{chk('manualWeightNeedsApproval', 'Manual weight needs manager PIN')}{chk('operatorCanReprint', 'Operators may reprint')}{chk('reprintReasonRequired', 'Reprint reason required')}{chk('holdCrossTerminal', 'Resume held bill on any counter')}{chk('allowMockScale', 'Accept simulator weights (testing only!)')}</div>
      <div className="acts"><b>Payment modes on the bill:</b>{['CASH', 'UPI', 'CARD', 'BANK', 'CREDIT'].map((m) => <label key={m} className="chk"><input type="checkbox" checked={(B.paymentModes || []).includes(m)} onChange={(e) => set('billing', 'paymentModes', e.target.checked ? [...(B.paymentModes || []), m] : (B.paymentModes || []).filter((x) => x !== m))} /> {m}</label>)}</div></Card>
    <Card title="Discount limits (% of bill)"><div className="form2">{Object.entries(s.discountLimits).map(([r, v]) => <Field key={r} label={r}><input value={v / 100} onChange={(e) => setS({ ...s, discountLimits: { ...s.discountLimits, [r]: Math.round(parseFloat(e.target.value || '0') * 100) } })} /></Field>)}</div></Card>
    <Card title="Printing & backup"><div className="form2">
      <Field label="Default paper"><select value={s.print.paper} onChange={(e) => set('print', 'paper', e.target.value)}>{['58mm', '80mm', 'A4'].map((x) => <option key={x}>{x}</option>)}</select></Field>
      <Field label="Copies"><input value={s.print.copies} onChange={(e) => set('print', 'copies', +e.target.value || 1)} /></Field>
      <label className="chk"><input type="checkbox" checked={s.print.silent} onChange={(e) => set('print', 'silent', e.target.checked)} /> Print without dialog</label>
      <label className="chk"><input type="checkbox" checked={s.print.showGstBreakup} onChange={(e) => set('print', 'showGstBreakup', e.target.checked)} /> Show CGST/SGST</label>
      <Field label="When a bill is saved"><select value={s.print.saveCopy || 'OFF'} onChange={(e) => set('print', 'saveCopy', e.target.value)}><option value="OFF">Print only</option><option value="PRINT_AND_SAVE">Print + save a PDF copy on the PC</option><option value="SAVE_ONLY">Save a PDF on the PC only (no printing)</option></select></Field>
      <div className="acts"><button type="button" onClick={() => openBillsFolder().then((r) => { if (!r.ok) toast(r.error || 'Could not open the folder', 'error'); })}>Open saved bills folder</button><span className="mut">Documents › Unique Basket Bills, on the PC that made the bill</span></div>
      <Field label="Daily backup at"><input value={s.backup.dailyAt} onChange={(e) => set('backup', 'dailyAt', e.target.value)} /></Field><Field label="Keep backups (days)"><input value={s.backup.keepDays} onChange={(e) => set('backup', 'keepDays', +e.target.value)} /></Field></div></Card>
    <Card title="Keyboard shortcuts (blank = default)"><div className="form2">{Object.entries(ACTIONS).map(([a, x]) => <Field key={a} label={`${x.label} — default ${x.keys.join(' / ')}`}><input value={s.shortcuts[a] || ''} placeholder={x.keys[0]} onChange={(e) => setS({ ...s, shortcuts: { ...s.shortcuts, [a]: e.target.value } })} /></Field>)}</div></Card>
    <div><Msg m={err} /><button className="b big" onClick={save}>Save all settings</button></div>
  </div>;
}

export function Backup({ user }) {
  const toast = useToast(); const [list, setList] = useState(null), [r, setR] = useState(null), [busy, setBusy] = useState(false);
  const load = () => get('/backups').then(setList);
  useEffect(() => { load(); }, []);
  return <div className="pad">
    <Card title="Backups" right={<button className="b" disabled={busy} onClick={async () => { setBusy(true); try { const b = await post('/backups'); toast('Backup saved: ' + b.file, 'ok'); load(); } catch (e) { toast(e.message, 'error'); } setBusy(false); }}>Backup now</button>}>
      <div className="mut">Automatic daily backup on the server PC (Settings). Copy the backups folder to a USB / cloud drive regularly.</div>
      <Table cols={[['Date', (b) => dt(b.at)], ['File', 'file'], ['Size', (b) => (b.size ? (b.size / 1024).toFixed(0) + ' KB' : ''), { n: 1 }], ['Status', 'status'], ['By', 'by'], ['Location', 'location'], ['', (b) => (b.file ? <button onClick={() => setR(b)}>Restore…</button> : '')]]} rows={list} /></Card>
    {r && <RestoreDialog b={r} onClose={() => setR(null)} onDone={() => { setR(null); toast('Restored. Restart all counters.', 'ok'); load(); }} />}
  </div>;
}
function RestoreDialog({ b, onClose, onDone }) {
  const [c, setC] = useState(''), [p, setP] = useState(''), [err, setErr] = useState('');
  return <Modal title="Restore backup" onClose={onClose} width={420}><form onSubmit={async (e) => { e.preventDefault(); try { await post('/backups/restore', { file: b.file, confirm: c, password: p }); onDone(); } catch (x) { setErr(x.message); } }}>
    <div className="warnbox">All current data will be replaced by the backup from {dt(b.at)}. A safety backup of the current data is taken first.</div>
    <Field label="Type RESTORE"><input value={c} onChange={(e) => setC(e.target.value)} data-autofocus /></Field><Field label="Your password"><input type="password" value={p} onChange={(e) => setP(e.target.value)} /></Field><Msg m={err} />
    <div className="row-r"><button type="button" onClick={onClose}>Cancel</button><button className="b d">Restore</button></div></form></Modal>;
}
export function Audit() {
  const [rows, setRows] = useState(null), [f, setF] = useState({ action: '', user: '' });
  const load = () => get('/audit?' + new URLSearchParams(Object.fromEntries(Object.entries(f).filter(([, v]) => v)))).then(setRows);
  useEffect(() => { load(); }, []);
  const show = (x) => (x == null ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x));
  return <div className="pad"><Card title="Audit log" right={<span className="acts"><input placeholder="Action e.g. PRICE_CHANGE" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value.toUpperCase() })} /><input placeholder="User" value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} /><button onClick={load}>Filter</button></span>}>
    <Table cols={[['Time', (a) => dt(a.at)], ['User', 'user'], ['Role', 'role'], ['Terminal', 'terminal'], ['Action', (a) => <b>{a.action}</b>], ['Detail', 'detail'], ['Old', (a) => show(a.old)], ['New', (a) => show(a.new)], ['Reason', 'reason'], ['Approved by', 'approvedBy']]} rows={rows} /></Card></div>;
}
