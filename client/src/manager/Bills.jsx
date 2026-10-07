import { useEffect, useState } from 'react';
import { get, post, uid } from '../lib/api';
import { rs, dt, qtyStr, unitLabel, today, parseQty } from '../lib/fmt';
import { receiptHtml, printHtml } from '../lib/print';
import { Table, Card, DateRange } from './common';
import { Modal, Field, Msg, useToast, useApprovals } from '../components/ui';
export default function Bills({ conf, bus, terminal }) {
  const toast = useToast(), withAp = useApprovals();
  const [r, setR] = useState({ from: today(), to: today() }), [f, setF] = useState({ no: '', terminal: '', status: '' }), [rows, setRows] = useState(null), [b, setB] = useState(null), [act, setAct] = useState(null);
  const load = () => { const p = new URLSearchParams({ from: r.from, to: r.to, limit: 300 }); for (const [k, v] of Object.entries(f)) if (v) p.set(k, v); get('/bills?' + p).then(setRows).catch((e) => toast(e.message, 'error')); };
  useEffect(load, [r, f.status, f.terminal]);
  useEffect(() => { const o = [bus.on('bill:completed', load), bus.on('bill:cancelled', load)]; return () => o.forEach((x) => x()); }, [r, f]);
  const open = (x) => get('/bills/' + x._id).then(setB);
  const reprint = async () => { try { await withAp((ap) => post(`/bills/${b._id}/printed`, { reprint: true, approval: ap.reprint, reason: 'manager reprint' })); await printHtml(receiptHtml(b, conf.shop, { paper: terminal?.print?.paper || conf.print.paper, duplicate: true }), { printer: terminal?.print?.printer, silent: conf.print.silent, paper: terminal?.print?.paper || conf.print.paper, save: conf.print.saveCopy, fileName: b.no + '-duplicate' }); } catch (e) { if (!e.cancelled) toast(e.message, 'error'); } };
  return <div className="pad cols2w">
    <Card title="Bills" right={<><DateRange value={r} onChange={setR} /> <input placeholder="Bill no" value={f.no} onChange={(e) => setF({ ...f, no: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && load()} style={{ width: 120 }} />
      <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">All status</option>{['COMPLETED', 'CANCELLED', 'PARTIALLY_RETURNED', 'RETURNED'].map((s) => <option key={s}>{s}</option>)}</select></>}>
      <Table cols={[['Time', (x) => dt(x.at)], ['No', 'no'], ['Counter', 'terminalCode'], ['Operator', 'by'], ['Customer', (x) => x.customer || 'Walk-in'], ['Mode', 'mode'], ['Total', 'total', { money: 1 }], ['Status', 'status']]} rows={rows} onRow={open} sel={b?._id} />
      {rows && <div className="mut">Total of completed: ₹{rs(rows.filter((x) => x.status !== 'CANCELLED').reduce((s, x) => s + x.total - (x.returnedAmount || 0), 0))}</div>}</Card>
    {b && <Card title={`Bill ${b.no}`} right={<span className="acts"><button onClick={reprint}>Reprint</button>{['COMPLETED', 'PARTIALLY_RETURNED'].includes(b.status) && <button onClick={() => setAct('return')}>Return</button>}{b.status === 'COMPLETED' && <button className="d" onClick={() => setAct('cancel')}>Cancel bill</button>}</span>}>
      <div className="kv"><span>Date</span><b>{dt(b.at)}</b><span>Counter</span><b>{b.terminalCode}</b><span>Operator</span><b>{b.by}</b><span>Customer</span><b>{b.customer || 'Walk-in'} {b.customerPhone}</b><span>Status</span><b>{b.status}</b><span>Payments</span><b>{(b.payments || []).map((p) => `${p.mode} ${rs(p.amount)}`).join(' + ')}</b>{b.cancel && <><span>Cancelled</span><b>{b.cancel.by} · {b.cancel.reason}</b></>}<span>Printed</span><b>{b.printCount || 0}×{(b.reprints || []).length ? ` (${b.reprints.length} reprints)` : ''}</b></div>
      <Table cols={[['Item', 'name'], ['Qty', (l) => `${qtyStr(l.unit, l.qty)} ${unitLabel(l.unit)}`, { n: 1 }], ['Rate', 'rate', { money: 1 }], ['Disc', 'discount', { money: 1 }], ['Tax', 'taxAmount', { money: 1 }], ['Amount', 'amount', { money: 1 }], ['Src', 'src']]} rows={b.items} />
      <div className="kv"><span>Gross</span><b>{rs(b.sub)}</b><span>Discount</span><b>{rs(b.discount)}</b><span>Tax</span><b>{rs(b.tax || 0)}</b><span>Round off</span><b>{rs(b.roundOff)}</b><span>Total</span><b>₹{rs(b.total)}</b>{b.returnedAmount ? <><span>Returned</span><b>₹{rs(b.returnedAmount)}</b></> : null}</div>
    </Card>}
    {act === 'cancel' && <CancelDialog b={b} onClose={() => setAct(null)} onDone={(x) => { setB(x); setAct(null); load(); toast('Bill cancelled, stock reversed', 'ok'); }} />}
    {act === 'return' && <ReturnDialog b={b} onClose={() => setAct(null)} onDone={() => { setAct(null); open(b); load(); toast('Return saved, stock updated', 'ok'); }} />}
  </div>;
}
function CancelDialog({ b, onClose, onDone }) {
  const withAp = useApprovals(); const [reason, setReason] = useState(''), [err, setErr] = useState('');
  const go = async (e) => { e.preventDefault(); try { onDone(await withAp((ap) => post(`/bills/${b._id}/cancel`, { reason, approval: ap.bill_cancel }))); } catch (x) { if (!x.cancelled) setErr(x.message); } };
  return <Modal title={`Cancel ${b.no}`} onClose={onClose} width={420}><form onSubmit={go}><div className="warnbox">The bill stays on record as CANCELLED. Stock and customer balance are reversed.</div><Field label="Reason *"><input data-autofocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field><Msg m={err} /><div className="row-r"><button type="button" onClick={onClose}>Back</button><button className="b d">Cancel bill</button></div></form></Modal>;
}
function ReturnDialog({ b, onClose, onDone }) {
  const withAp = useApprovals(); const [q, setQ] = useState({}), [mode, setMode] = useState('CASH'), [reason, setReason] = useState(''), [err, setErr] = useState(''), [key] = useState(uid());
  const go = async (e) => { e.preventDefault(); try {
    const items = Object.entries(q).filter(([, v]) => v).map(([i, v]) => ({ line: +i, qty: parseQty(b.items[i].unit, v) }));
    if (items.some((x) => !(x.qty > 0))) throw new Error('Invalid quantity');
    await withAp((ap) => post(`/bills/${b._id}/returns`, { items, refundMode: mode, reason, idemKey: key, approval: ap.bill_return })); onDone();
  } catch (x) { if (!x.cancelled) setErr(x.message); } };
  return <Modal title={`Return — ${b.no}`} onClose={onClose} width={560}><form onSubmit={go}>
    <Table cols={[['Item', 'name'], ['Sold', (l) => `${qtyStr(l.unit, l.qty)} ${unitLabel(l.unit)}`, { n: 1 }], ['Return qty', (l) => { const i = b.items.indexOf(l); return <input style={{ width: 90 }} value={q[i] || ''} onChange={(e) => setQ({ ...q, [i]: e.target.value })} placeholder={qtyStr(l.unit, 0)} />; }]]} rows={b.items} />
    <div className="form2"><Field label="Refund"><select value={mode} onChange={(e) => setMode(e.target.value)}>{['CASH', 'UPI', 'CARD', 'BANK', ...(b.customerId ? ['CREDIT_NOTE'] : [])].map((m) => <option key={m}>{m}</option>)}</select></Field><Field label="Reason *"><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field></div>
    <Msg m={err} /><div className="row-r"><button type="button" onClick={onClose}>Back</button><button className="b">Save return</button></div></form></Modal>;
}
