/** Customers (+ledger, receipts, credit limit) and Suppliers + Purchase entry + Stock adjust/wastage. */
import { useEffect, useMemo, useState } from 'react';
import { get, post, put } from '../lib/api';
import { rs, paise, parseQty, qtyStr, unitLabel, dt, today, isWeighed } from '../lib/fmt';
import { Table, Card, DateRange, Q } from './common';
import { Field, Msg, Modal, useToast } from '../components/ui';

export function Customers({ user }) {
  const toast = useToast();
  const [q, setQ] = useState(''), [list, setList] = useState(null), [f, setF] = useState(null), [led, setLed] = useState(null), [pay, setPay] = useState(null), [err, setErr] = useState('');
  const load = () => get('/customers?all=1&limit=200&q=' + encodeURIComponent(q)).then(setList);
  useEffect(() => { const t = setTimeout(load, 150); return () => clearTimeout(t); }, [q]);
  const save = async () => { setErr(''); try { const b = { ...f, creditLimit: f.creditLimitT ? paise(f.creditLimitT) : 0, openingBalance: f.openingT ? paise(f.openingT) : 0 }; if (f._id) await put('/customers/' + f._id, b); else await post('/customers', b); setF(null); load(); toast('Customer saved', 'ok'); } catch (e) { setErr(e.message); } };
  const ledger = async (c, r = { from: '', to: '' }) => setLed({ c, r, d: await get(`/customers/${c._id}/ledger?from=${r.from}&to=${r.to}`) });
  return <div className="pad cols2w">
    <Card title="Customers" right={<><input placeholder="Name / mobile / code" value={q} onChange={(e) => setQ(e.target.value)} /> <button className="b" onClick={() => setF({ name: '', mobile: '', address: '', gstin: '', type: 'RETAIL', creditAllowed: false, creditLimitT: '', openingT: '', notes: '', active: true })}>+ Add</button></>}>
      <Table cols={[['Code', 'code'], ['Name', 'name'], ['Mobile', 'mobile'], ['Type', 'type'], ['Credit', (c) => (c.creditAllowed ? '₹' + rs(c.creditLimit || 0) : '—')], ['Balance', 'balance', { money: 1 }], ['', (c) => <span className="acts"><button onClick={(e) => { e.stopPropagation(); ledger(c); }}>Ledger</button><button onClick={(e) => { e.stopPropagation(); setPay(c); }}>Receive</button></span>]]} rows={list} onRow={(c) => setF({ ...c, creditLimitT: c.creditLimit ? (c.creditLimit / 100).toFixed(2) : '' })} sel={f?._id} /></Card>
    {f && <Card title={f._id ? 'Edit customer' : 'New customer'}><div className="form2">
      <Field label="Name *"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field><Field label="Mobile"><input value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} /></Field>
      <Field label="Address"><input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field><Field label="GSTIN"><input value={f.gstin || ''} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })} /></Field>
      <Field label="Type"><select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{['RETAIL', 'WHOLESALE', 'HOTEL', 'VENDOR', 'OTHER'].map((t) => <option key={t}>{t}</option>)}</select></Field>
      <Field label="Credit limit ₹"><input value={f.creditLimitT} onChange={(e) => setF({ ...f, creditLimitT: e.target.value })} /></Field>
      {!f._id && <Field label="Opening balance ₹ (owes us)"><input value={f.openingT} onChange={(e) => setF({ ...f, openingT: e.target.value })} /></Field>}
      <Field label="Notes"><input value={f.notes || ''} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <label className="chk"><input type="checkbox" checked={!!f.creditAllowed} onChange={(e) => setF({ ...f, creditAllowed: e.target.checked })} /> Credit allowed</label>
      <label className="chk"><input type="checkbox" checked={f.active !== false} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label></div>
      <Msg m={err} /><div className="row-r"><button onClick={() => setF(null)}>Cancel</button><button className="b" onClick={save}>Save</button></div></Card>}
    {led && <Modal title={`Ledger — ${led.c.name}`} onClose={() => setLed(null)} width={820}>
      <div className="row-r" style={{ justifyContent: 'flex-start' }}><DateRange value={led.r} onChange={(r) => ledger(led.c, r)} /><button onClick={() => window.print()}>Print</button></div>
      <div className="kv"><span>Opening</span><b>₹{rs(led.d.opening)}</b><span>Debit</span><b>₹{rs(led.d.debit)}</b><span>Credit</span><b>₹{rs(led.d.credit)}</b><span>Closing</span><b>₹{rs(led.d.closing)}</b></div>
      <Table cols={[['Date', (r) => dt(r.at)], ['Type', 'type'], ['Ref', 'ref'], ['Debit', 'debit', { money: 1 }], ['Credit', 'credit', { money: 1 }], ['Balance', 'balance', { money: 1 }], ['By', 'by']]} rows={led.d.rows} /></Modal>}
    {pay && <ReceiveDialog c={pay} onClose={() => setPay(null)} onDone={() => { setPay(null); load(); toast('Payment recorded', 'ok'); }} />}
  </div>;
}
function ReceiveDialog({ c, onClose, onDone }) {
  const [a, setA] = useState(''), [m, setM] = useState('CASH'), [ref, setRef] = useState(''), [err, setErr] = useState('');
  return <Modal title={`Receive payment — ${c.name}`} onClose={onClose} width={380}><form onSubmit={async (e) => { e.preventDefault(); try { await post(`/customers/${c._id}/payments`, { amount: paise(a), mode: m, ref }); onDone(); } catch (x) { setErr(x.message); } }}>
    <div className="mut">Outstanding ₹{rs(c.balance || 0)}</div><Field label="Amount ₹"><input data-autofocus value={a} onChange={(e) => setA(e.target.value)} /></Field>
    <Field label="Mode"><select value={m} onChange={(e) => setM(e.target.value)}>{['CASH', 'UPI', 'CARD', 'BANK'].map((x) => <option key={x}>{x}</option>)}</select></Field><Field label="Reference"><input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
    <Msg m={err} /><div className="row-r"><button className="b">Save</button></div></form></Modal>;
}

export function Purchases() {
  const toast = useToast();
  const [sup, setSup] = useState([]), [prods, setProds] = useState([]), [list, setList] = useState(null), [sf, setSf] = useState(null), [err, setErr] = useState('');
  const blank = { supplierId: '', invoiceNo: '', date: today(), items: [{ productId: '', qty: '', rate: '', taxRate: '0' }], charges: '', paid: '', paidMode: 'CASH' };
  const [f, setF] = useState(blank);
  const load = () => { get('/suppliers').then(setSup); get('/purchases').then(setList); };
  useEffect(() => { load(); get('/products?all=1').then(setProds); }, []);
  const pmap = useMemo(() => new Map(prods.map((p) => [p._id, p])), [prods]);
  const setItem = (i, k, v) => setF({ ...f, items: f.items.map((x, j) => (j === i ? { ...x, [k]: v } : x)) });
  const save = async () => { setErr(''); try {
    const items = f.items.filter((x) => x.productId).map((x) => { const p = pmap.get(x.productId); return { productId: x.productId, qty: parseQty(p.unit, x.qty), rate: paise(x.rate), taxRate: Math.round(parseFloat(x.taxRate || '0') * 100) }; });
    const r = await post('/purchases', { supplierId: f.supplierId, invoiceNo: f.invoiceNo, date: f.date, items, charges: f.charges ? paise(f.charges) : 0, paid: { amount: f.paid ? paise(f.paid) : 0, mode: f.paidMode } });
    toast(`Purchase ${r.no} saved · stock updated`, 'ok'); setF(blank); load();
  } catch (e) { setErr(e.message); } };
  const saveSup = async () => { try { if (sf._id) await put('/suppliers/' + sf._id, sf); else await post('/suppliers', { ...sf, openingBalance: sf.openingT ? paise(sf.openingT) : 0 }); setSf(null); load(); } catch (e) { setErr(e.message); } };
  return <div className="pad">
    <Card title="Purchase entry"><div className="form2">
      <Field label="Supplier *"><select value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })}><option value="">Select…</option>{sup.filter((s) => s.active !== false).map((s) => <option key={s._id} value={s._id}>{s.name}</option>)}</select></Field>
      <Field label="Supplier invoice no"><input value={f.invoiceNo} onChange={(e) => setF({ ...f, invoiceNo: e.target.value })} /></Field><Field label="Date"><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field></div>
      <table className="tbl"><thead><tr><th>Product</th><th>Qty</th><th>Rate ₹/unit</th><th>GST %</th><th></th></tr></thead><tbody>{f.items.map((x, i) => <tr key={i}>
        <td><select value={x.productId} onChange={(e) => setItem(i, 'productId', e.target.value)}><option value="">—</option>{prods.map((p) => <option key={p._id} value={p._id}>{p.name} ({unitLabel(p.unit)})</option>)}</select></td>
        <td><input value={x.qty} onChange={(e) => setItem(i, 'qty', e.target.value)} placeholder={x.productId && isWeighed(pmap.get(x.productId)?.unit) ? 'kg e.g. 250.000' : 'count'} /></td>
        <td><input value={x.rate} onChange={(e) => setItem(i, 'rate', e.target.value)} /></td><td><input value={x.taxRate} onChange={(e) => setItem(i, 'taxRate', e.target.value)} style={{ width: 60 }} /></td>
        <td><button onClick={() => setF({ ...f, items: f.items.filter((_, j) => j !== i) })}>✕</button></td></tr>)}</tbody></table>
      <div className="form2"><button onClick={() => setF({ ...f, items: [...f.items, { productId: '', qty: '', rate: '', taxRate: '0' }] })}>+ Line</button>
        <Field label="Other charges ₹"><input value={f.charges} onChange={(e) => setF({ ...f, charges: e.target.value })} /></Field><Field label="Paid now ₹"><input value={f.paid} onChange={(e) => setF({ ...f, paid: e.target.value })} /></Field>
        <Field label="Paid by"><select value={f.paidMode} onChange={(e) => setF({ ...f, paidMode: e.target.value })}>{['CASH', 'UPI', 'BANK', 'CARD'].map((m) => <option key={m}>{m}</option>)}</select></Field></div>
      <Msg m={err} /><div className="row-r"><button className="b" onClick={save}>Save purchase (stock in)</button></div></Card>
    <div className="cols2">
      <Card title="Recent purchases"><Table cols={[['Date', 'date'], ['No', 'no'], ['Supplier', 'supplierName'], ['Inv', 'invoiceNo'], ['Total', 'total', { money: 1 }], ['Paid', 'paid', { money: 1 }], ['Status', 'paymentStatus']]} rows={list} /></Card>
      <Card title="Suppliers" right={<button className="b" onClick={() => setSf({ name: '', mobile: '', address: '', gstin: '', creditDays: 0, active: true, openingT: '' })}>+ Add</button>}>
        <Table cols={[['Code', 'code'], ['Name', 'name'], ['Mobile', 'mobile'], ['Payable', 'balance', { money: 1 }]]} rows={sup} onRow={setSf} />
        {sf && <div className="form2"><Field label="Name"><input value={sf.name} onChange={(e) => setSf({ ...sf, name: e.target.value })} /></Field><Field label="Mobile"><input value={sf.mobile || ''} onChange={(e) => setSf({ ...sf, mobile: e.target.value })} /></Field><Field label="GSTIN"><input value={sf.gstin || ''} onChange={(e) => setSf({ ...sf, gstin: e.target.value.toUpperCase() })} /></Field><Field label="Address"><input value={sf.address || ''} onChange={(e) => setSf({ ...sf, address: e.target.value })} /></Field>{!sf._id && <Field label="Opening payable ₹"><input value={sf.openingT} onChange={(e) => setSf({ ...sf, openingT: e.target.value })} /></Field>}<button className="b" onClick={saveSup}>Save supplier</button><button onClick={() => setSf(null)}>Cancel</button></div>}</Card>
    </div></div>;
}

export function Stock({ bus }) {
  const toast = useToast();
  const [prods, setProds] = useState([]), [pid, setPid] = useState(''), [led, setLed] = useState(null), [f, setF] = useState({ kind: 'ADJUST', qty: '', reason: '', note: '' }), [err, setErr] = useState('');
  const load = () => get('/products?all=1').then(setProds);
  useEffect(() => { load(); return bus.on('inventory:updated', load); }, []);
  const p = prods.find((x) => x._id === pid);
  useEffect(() => { if (pid) get('/stock/ledger/' + pid).then(setLed); }, [pid, prods]);
  const save = async () => { setErr(''); try { const qty = parseQty(p.unit, f.qty.replace('-', '')) * (f.qty.trim().startsWith('-') ? -1 : 1); if (!qty) throw new Error('Enter quantity');
    await post(f.kind === 'WASTAGE' ? '/stock/wastage' : '/stock/adjust', { productId: pid, qty, reason: f.reason || (f.kind === 'WASTAGE' ? 'SPOILAGE' : ''), note: f.note }); toast('Stock updated', 'ok'); setF({ ...f, qty: '', note: '' }); load(); } catch (e) { setErr(e.message); } };
  return <div className="pad cols2w">
    <Card title="Stock"><Table cols={[['Product', 'name'], ['Category', 'category'], ['Stock', (x) => <Q u={x.unit} n={x.stock || 0} />, { n: 1 }], ['Min', (x) => (x.minStock ? <Q u={x.unit} n={x.minStock} /> : ''), { n: 1 }], ['', (x) => (x.minStock && x.stock <= x.minStock ? <span className="tag">LOW</span> : '')]]} rows={prods} onRow={(x) => setPid(x._id)} sel={pid} /></Card>
    <div>{p ? <>
      <Card title={`${p.name} — stock ${qtyStr(p.unit, p.stock || 0)} ${unitLabel(p.unit)}`}><div className="form2">
        <Field label="Type"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, reason: '' })}><option value="ADJUST">Adjustment (+/-)</option><option value="WASTAGE">Wastage / damage</option></select></Field>
        <Field label={`Quantity ${unitLabel(p.unit)}${f.kind === 'ADJUST' ? ' (use - to reduce)' : ''}`}><input value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></Field>
        <Field label="Reason">{f.kind === 'WASTAGE' ? <select value={f.reason || 'SPOILAGE'} onChange={(e) => setF({ ...f, reason: e.target.value })}>{['SPOILAGE', 'DAMAGE', 'EXPIRY', 'HANDLING_LOSS', 'OTHER'].map((x) => <option key={x}>{x}</option>)}</select> : <input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Physical count / correction" />}</Field>
        <Field label="Note"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field></div><Msg m={err} /><div className="row-r"><button className="b" onClick={save}>Save</button></div></Card>
      <Card title="Stock ledger"><Table cols={[['Date', (r) => dt(r.at)], ['Type', 'type'], ['Ref', 'ref'], ['In', (r) => (r.in ? qtyStr(p.unit, r.in) : ''), { n: 1 }], ['Out', (r) => (r.out ? qtyStr(p.unit, r.out) : ''), { n: 1 }], ['Balance', (r) => qtyStr(p.unit, r.balance), { n: 1 }], ['By', 'by'], ['Reason', 'reason']]} rows={led ? [...led].reverse() : null} max={300} /></Card></> : <Card title="Select a product">Click a product to adjust stock or see its ledger.</Card>}</div>
  </div>;
}
