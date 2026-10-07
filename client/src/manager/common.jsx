import { useState } from 'react';
import { rs, qtyStr, unitLabel, dt } from '../lib/fmt';
/** compact data table. cols: [label, fn(row) | key, {n:true right-align, money:true}] */
export function Table({ cols, rows, onRow, sel, empty = 'No records', max }) {
  const list = max ? (rows || []).slice(0, max) : rows || [];
  return <div className="tblwrap"><table className="tbl"><thead><tr>{cols.map((c, i) => <th key={i} className={c[2]?.n || c[2]?.money ? 'n' : ''}>{c[0]}</th>)}</tr></thead>
    <tbody>{list.map((r, i) => <tr key={r._id || i} className={sel && sel === r._id ? 'sel' : ''} onClick={onRow ? () => onRow(r) : undefined} style={onRow ? { cursor: 'pointer' } : null}>
      {cols.map((c, j) => { const v = typeof c[1] === 'function' ? c[1](r) : r[c[1]]; return <td key={j} className={c[2]?.n || c[2]?.money ? 'n' : ''}>{c[2]?.money ? (v == null ? '' : rs(v)) : v}</td>; })}</tr>)}
      {rows && !list.length && <tr><td colSpan={cols.length} className="empty">{empty}</td></tr>}
      {!rows && <tr><td colSpan={cols.length} className="empty">Loading…</td></tr>}</tbody></table></div>;
}
export const Q = ({ u, n }) => <>{qtyStr(u, n)} {unitLabel(u)}</>;
export const Card = ({ title, children, right }) => <div className="card"><div className="ch"><b>{title}</b><span>{right}</span></div>{children}</div>;
export const Tile = ({ k, v, sub }) => <div className="tile"><small>{k}</small><div>{v}</div>{sub && <small>{sub}</small>}</div>;
export function DateRange({ value, onChange }) {
  return <span className="dr2"><input type="date" value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} /> to <input type="date" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} /></span>;
}
export { rs, dt };
