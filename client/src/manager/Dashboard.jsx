import { useEffect, useState } from 'react';
import { get } from '../lib/api';
import { rs, tm } from '../lib/fmt';
import { Table, Tile, Card } from './common';
/** Live dashboard: refreshes on bill/terminal events (and every 60 s as a safety net). */
export default function Dashboard({ bus }) {
  const [d, setD] = useState(null), [feed, setFeed] = useState([]), [err, setErr] = useState('');
  const load = () => get('/dashboard').then(setD).catch((e) => setErr(e.message));
  const loadFeed = () => get('/bills?limit=40').then(setFeed).catch(() => {});
  useEffect(() => { load(); loadFeed(); const t = setInterval(load, 60000); return () => clearInterval(t); }, []);
  useEffect(() => { let t; const later = () => { clearTimeout(t); t = setTimeout(load, 400); };
    const offs = [bus.on('bill:completed', (b) => { setFeed((f) => [b, ...f].slice(0, 60)); later(); }), bus.on('bill:cancelled', (b) => { setFeed((f) => f.map((x) => (x._id === b._id ? { ...x, status: 'CANCELLED' } : x))); later(); }),
      bus.on('bill:returned', later), bus.on('terminal:online', later), bus.on('terminal:offline', later), bus.on('purchase:created', later), bus.on('sync', () => { load(); loadFeed(); })];
    return () => { offs.forEach((f) => f()); clearTimeout(t); }; }, []);
  if (!d) return <div className="pad">{err || 'Loading…'}</div>;
  return <div className="pad">
    <div className="tiles"><Tile k="Today's sales" v={'₹' + rs(d.sales)} sub={`net ₹${rs(d.netSales)}`} /><Tile k="Bills" v={d.bills} sub={`${d.cancelled} cancelled`} /><Tile k="Cash" v={'₹' + rs(d.CASH)} /><Tile k="UPI" v={'₹' + rs(d.UPI)} /><Tile k="Card / Bank" v={'₹' + rs(d.CARD + d.BANK)} /><Tile k="Credit" v={'₹' + rs(d.CREDIT)} />
      <Tile k="Returns" v={'₹' + rs(d.returns)} /><Tile k="Discounts" v={'₹' + rs(d.discounts)} /><Tile k="Outstanding" v={'₹' + rs(d.outstanding)} /><Tile k="Purchases" v={'₹' + rs(d.purchases)} /><Tile k="Low stock" v={d.lowStock.length} /><Tile k="Held bills" v={d.held} /></div>
    <div className="cols2">
      <Card title="Counters"><Table cols={[['Counter', (c) => <b>{c.code}</b>], ['Name', 'name'], ['Status', (c) => <span className={c.status === 'ONLINE' ? 'ok' : 'bad'}>{c.status}</span>], ['Operator', 'currentUser'], ['Scale', 'scaleStatus'], ['Bills', 'bills', { n: 1 }], ['Sales', 'sales', { money: 1 }]]} rows={d.counters} /></Card>
      <Card title="Low stock"><Table cols={[['Product', 'name'], ['Stock', (p) => (p.unit === 'KG' ? (p.stock / 1000).toFixed(3) : p.stock), { n: 1 }], ['Min', (p) => (p.unit === 'KG' ? (p.minStock / 1000).toFixed(3) : p.minStock), { n: 1 }]]} rows={d.lowStock} empty="All good" /></Card>
    </div>
    <Card title="Live bill monitor" right={<span className="mut">updates automatically</span>}>
      <Table cols={[['Time', (b) => tm(b.at)], ['Bill No', 'no'], ['Counter', (b) => b.terminalCode || b.counter], ['Operator', 'by'], ['Customer', (b) => b.customer || 'Walk-in'], ['Items', (b) => (Array.isArray(b.items) ? b.items.length : b.items), { n: 1 }], ['Amount', 'total', { money: 1 }], ['Payment', 'mode'], ['Status', 'status']]} rows={feed} max={60} /></Card>
  </div>;
}
