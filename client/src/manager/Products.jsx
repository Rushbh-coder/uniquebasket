import { useEffect, useMemo, useState } from 'react';
import { get, post, put, del } from '../lib/api';
import { rs, paise, parseQty, qtyStr, unitLabel, dt, isWeighed } from '../lib/fmt';
import { Table, Card, Q } from './common';
import { Field, Msg, Modal, useToast } from '../components/ui';
const UNITS = ['KG', 'PCS', 'DOZEN', 'BOX', 'BAG', 'CRATE', 'BUNDLE', 'LITRE'];
const toForm = (p) => ({ ...p, rate: p ? (p.rate / 100).toFixed(2) : '', purchaseRate: p?.purchaseRate ? (p.purchaseRate / 100).toFixed(2) : '', mrp: p?.mrp ? (p.mrp / 100).toFixed(2) : '', minRate: p?.minRate ? (p.minRate / 100).toFixed(2) : '', taxRate: p?.taxRate ? String(p.taxRate / 100) : '0', maxDiscount: p?.maxDiscountBp ? String(p.maxDiscountBp / 100) : '', minStock: p?.minStock ? qtyStr(p.unit, p.minStock) : '', openingStock: '', unitWeight: p?.unitWeight || '' });
const blank = { name: '', code: '', barcode: '', localName: '', category: '', unit: 'KG', hsn: '', allowManualWeight: true, allowManualRate: false, active: true };
export default function Products({ bus, user }) {
  const toast = useToast();
  const [list, setList] = useState(null), [q, setQ] = useState(''), [f, setF] = useState(null), [err, setErr] = useState(''), [price, setPrice] = useState(null), [hist, setHist] = useState(null), [sched, setSched] = useState([]);
  const load = () => { get('/products?all=1').then(setList); get('/prices/scheduled').then(setSched).catch(() => {}); };
  useEffect(() => { load(); const offs = ['product:price-updated', 'product:updated', 'product:created', 'inventory:updated'].map((e) => bus.on(e, load)); return () => offs.forEach((x) => x()); }, []);
  const rows = useMemo(() => (list || []).filter((p) => !q || (p.name + p.code + (p.localName || '') + (p.category || '') + (p.barcode || '')).toLowerCase().includes(q.toLowerCase())), [list, q]);
  const save = async () => {
    setErr('');
    try {
      const b = { name: f.name, code: f.code, barcode: f.barcode, localName: f.localName, category: f.category, unit: f.unit, hsn: f.hsn, allowManualWeight: f.allowManualWeight, allowManualRate: f.allowManualRate, active: f.active,
        purchaseRate: f.purchaseRate ? paise(f.purchaseRate) : 0, mrp: f.mrp ? paise(f.mrp) : 0, minRate: f.minRate ? paise(f.minRate) : 0, taxRate: Math.round(parseFloat(f.taxRate || '0') * 100), maxDiscountBp: f.maxDiscount ? Math.round(parseFloat(f.maxDiscount) * 100) : 0,
        minStock: f.minStock ? parseQty(f.unit, f.minStock) : 0, unitWeight: +f.unitWeight || 0 };
      if (f._id) await put('/products/' + f._id, b);
      else await post('/products', { ...b, rate: paise(f.rate), openingStock: f.openingStock ? parseQty(f.unit, f.openingStock) : 0 });
      toast('Product saved', 'ok'); setF(null); load();
    } catch (e) { setErr(e.message); }
  };
  return <div className="pad cols2w">
    <Card title={`Products (${rows.length})`} right={<><input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 180 }} /> <button className="b" onClick={() => setF(toForm(null) && { ...toForm(null), ...blank })}>+ Add</button></>}>
      <Table cols={[['Code', 'code'], ['Product', (p) => <>{p.name}{p.localName && <small className="mut"> {p.localName}</small>}</>], ['Category', 'category'], ['Unit', (p) => unitLabel(p.unit)], ['Rate', 'rate', { money: 1 }], ['GST', (p) => (p.taxRate ? p.taxRate / 100 + '%' : ''), { n: 1 }], ['Stock', (p) => <Q u={p.unit} n={p.stock || 0} />, { n: 1 }], ['', (p) => (p.active === false ? <span className="tag">OFF</span> : '')],
        ['', (p) => <span className="acts"><button onClick={(e) => { e.stopPropagation(); setPrice(p); }}>Rate</button><button onClick={(e) => { e.stopPropagation(); get(`/products/${p._id}/prices`).then((h) => setHist({ p, h })); }}>History</button></span>]]}
        rows={rows} onRow={(p) => setF(toForm(p))} sel={f?._id} /></Card>
    <div>
      {f && <Card title={f._id ? 'Edit product' : 'New product'}><div className="form2">
        <Field label="Name *"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field><Field label="Local name"><input value={f.localName || ''} onChange={(e) => setF({ ...f, localName: e.target.value })} /></Field>
        <Field label="Code"><input value={f.code || ''} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field><Field label="Barcode"><input value={f.barcode || ''} onChange={(e) => setF({ ...f, barcode: e.target.value })} /></Field>
        <Field label="Category"><input value={f.category || ''} onChange={(e) => setF({ ...f, category: e.target.value })} /></Field>
        <Field label="Unit"><select value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} disabled={!!f._id}>{UNITS.map((u) => <option key={u}>{u}</option>)}</select></Field>
        {!f._id && <Field label="Sale rate ₹ *"><input value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} /></Field>}
        <Field label="Purchase rate ₹"><input value={f.purchaseRate} onChange={(e) => setF({ ...f, purchaseRate: e.target.value })} /></Field><Field label="MRP ₹"><input value={f.mrp} onChange={(e) => setF({ ...f, mrp: e.target.value })} /></Field>
        <Field label="Min price ₹"><input value={f.minRate} onChange={(e) => setF({ ...f, minRate: e.target.value })} /></Field><Field label="GST %"><select value={f.taxRate} onChange={(e) => setF({ ...f, taxRate: e.target.value })}>{['0', '5', '12', '18', '28'].map((x) => <option key={x}>{x}</option>)}</select></Field>
        <Field label="HSN/SAC"><input value={f.hsn || ''} onChange={(e) => setF({ ...f, hsn: e.target.value })} /></Field><Field label="Max discount %"><input value={f.maxDiscount} onChange={(e) => setF({ ...f, maxDiscount: e.target.value })} /></Field>
        <Field label={`Min stock (${unitLabel(f.unit)})`}><input value={f.minStock} onChange={(e) => setF({ ...f, minStock: e.target.value })} /></Field>
        {!f._id && <Field label={`Opening stock (${unitLabel(f.unit)})`}><input value={f.openingStock} onChange={(e) => setF({ ...f, openingStock: e.target.value })} /></Field>}
        <label className="chk"><input type="checkbox" checked={f.allowManualWeight !== false} onChange={(e) => setF({ ...f, allowManualWeight: e.target.checked })} /> Allow manual weight</label>
        <label className="chk"><input type="checkbox" checked={!!f.allowManualRate} onChange={(e) => setF({ ...f, allowManualRate: e.target.checked })} /> Operator may change rate</label>
        <label className="chk"><input type="checkbox" checked={f.active !== false} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active</label>
      </div><Msg m={err} /><div className="row-r"><button onClick={() => setF(null)}>Cancel</button><button className="b" onClick={save}>Save</button></div>{f._id && <div className="mut">Change the sale rate with the "Rate" button (keeps history).</div>}</Card>}
      <Card title="Scheduled rate changes">{sched.length ? <Table cols={[['Product', 'productName'], ['New rate', 'rate', { money: 1 }], ['Effective', (s) => dt(s.effectiveAt)], ['By', 'by'], ['', (s) => <button onClick={() => del('/prices/scheduled/' + s._id).then(load)}>Cancel</button>]]} rows={sched} /> : <div className="mut">None</div>}</Card>
    </div>
    {price && <PriceDialog p={price} onClose={() => setPrice(null)} onDone={(m) => { toast(m, 'ok'); setPrice(null); load(); }} />}
    {hist && <Modal title={`Price history — ${hist.p.name}`} onClose={() => setHist(null)} width={640}><Table cols={[['Changed at', (r) => dt(r.at)], ['Effective', (r) => dt(r.effectiveAt)], ['Old', 'old', { money: 1 }], ['New', 'rate', { money: 1 }], ['By', 'by'], ['Counter', 'terminal'], ['Reason', 'reason']]} rows={hist.h} /></Modal>}
  </div>;
}
function PriceDialog({ p, onClose, onDone }) {
  const [rate, setRate] = useState((p.rate / 100).toFixed(2)), [when, setWhen] = useState(''), [reason, setReason] = useState(''), [err, setErr] = useState('');
  const go = async (e) => { e.preventDefault(); try { const r = await post(`/products/${p._id}/price`, { rate: paise(rate), effectiveAt: when ? new Date(when).toISOString() : undefined, reason }); onDone(r.scheduled ? `${p.name}: ₹${rate} scheduled` : `${p.name}: ₹${rate} — all counters updated`); } catch (x) { setErr(x.message); } };
  return <Modal title={`Change rate — ${p.name}`} onClose={onClose} width={400}><form onSubmit={go}>
    <div className="mut">Current: ₹{rs(p.rate)} / {unitLabel(p.unit)}. Old bills never change.</div>
    <Field label="New rate ₹"><input data-autofocus value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
    <Field label="Effective from (blank = now)"><input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
    <Field label="Reason (optional)"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field><Msg m={err} />
    <div className="row-r"><button type="button" onClick={onClose}>Cancel</button><button className="b">Save rate</button></div></form></Modal>;
}
