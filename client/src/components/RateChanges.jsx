import { useEffect, useMemo, useState } from 'react';
import { get } from '../lib/api';
import { rs, dt, unitLabel } from '../lib/fmt';
import { Table } from '../manager/common';

/** Sale-rate changes of all products, newest first. The same list on the operator and the manager side;
 *  it reloads by itself whenever a rate is changed on any PC. */
export default function RateChanges({ bus, products }) {
  const [rows, setRows] = useState(null), [q, setQ] = useState(''), [err, setErr] = useState('');
  useEffect(() => {
    const load = () => get('/prices/history').then((r) => { setRows(r); setErr(''); }).catch((e) => { setRows([]); setErr(e.message); });
    load();
    const offs = ['product:price-updated', 'product:created', 'sync'].map((e) => bus.on(e, load));
    return () => offs.forEach((x) => x());
  }, []);
  const unitOf = useMemo(() => new Map((products || []).map((p) => [p._id, p.unit])), [products]);
  const list = useMemo(() => rows && rows.filter((r) => !q || (r.productName || '').toLowerCase().includes(q.toLowerCase())), [rows, q]);
  const change = (r) => {
    if (r.old == null) return <span className="mut">New product</span>;
    const d = r.rate - r.old;
    return <span className={d > 0 ? 'bad' : 'ok'}>{d > 0 ? '▲ +' : '▼ -'}{rs(Math.abs(d))}</span>;
  };
  return <div>
    <div className="row-r"><input placeholder="Search product…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} /></div>
    {err && <div className="err">{err}</div>}
    <Table empty="No rate changes yet" cols={[['Changed at', (r) => dt(r.at)], ['Product', (r) => <>{r.productName}{unitOf.get(r.productId) && <small className="mut"> / {unitLabel(unitOf.get(r.productId))}</small>}</>],
      ['Old rate', 'old', { money: 1 }], ['New rate', (r) => <b>{rs(r.rate)}</b>, { n: 1 }], ['Change', change, { n: 1 }], ['By', 'by'], ['Reason', 'reason']]} rows={list} />
  </div>;
}
