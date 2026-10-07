/**
 * Sale Entry (billing / POS) screen — keyboard first, laid out like a sheet.
 * Flow without mouse:  product (type + Enter) -> weight (Enter = capture stable scale weight, or type manual) /
 * qty (Enter) -> row added -> cursor back to product.  End then Enter = save & print.
 * Lines keep the rate they were added at (quotedAt); manager price changes apply to NEW lines only.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import { flushSync } from 'react-dom';
import { get, post, uid } from '../lib/api';
import { connectScale } from '../lib/events';
import { pushScope, hint } from '../lib/shortcuts';
import { rs, qtyStr, unitLabel, isWeighed, parseQty, paise, lineAmount, tm, pct } from '../lib/fmt';
import { totals } from '../lib/calc';
import { receiptHtml, printHtml } from '../lib/print';
import { Modal, Field, Msg, useToast, useApprovals, Confirm } from '../components/ui';
import RateChanges from '../components/RateChanges';

const emptyEntry = { p: null, qtyText: '', rateText: '', tareText: '', rateEdited: false };
const emptyWalk = { name: '', mobile: '', address: '' };
const draftKey = (t) => 'draft:' + (t || 'x');
const COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
const MIN_ROWS = 10; // the sheet shows at least this many rows; on a bigger window it is filled to the bottom
const SALE_MODES = { RETAIL: 'Retail', WHOLESALE: 'Wholesale' };
const modeLabel = (m) => (m.length <= 3 ? m : m[0] + m.slice(1).toLowerCase());
const Trash = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v7M14 10v7" /></svg>;
/** key-bar button: never takes focus, so the cursor stays in the sheet */
const Key = ({ k, children, onClick, sec, short }) => <button className={sec ? 'sec' : ''} tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={onClick}><b>{k}</b>{short ? <><span className="lg">{children}</span><span className="sm">{short}</span></> : children}</button>;

export default function Pos({ user, conf, terminal, products, bus, serverOk, onExit, onLogout }) {
  const toast = useToast(), withApprovals = useApprovals();
  const can = (p) => user.perms.includes(p);
  const strict = !!conf.billing.operatorApprovals; // shop setting: manager PIN prompts while billing (off by default)
  const restored = useMemo(() => { try { return JSON.parse(localStorage.getItem(draftKey(terminal?.code)) || 'null'); } catch (e) { return null; } }, []);
  const [lines, setLines] = useState(restored?.lines || []);
  const [sel, setSel] = useState(-1);
  const [cust, setCust] = useState(restored?.cust || null);           // customer already known for the typed mobile number
  // the three customer boxes; always what is sent with the bill (a known customer is pre-filled and stays editable)
  const [walk, setWalk] = useState(restored?.cust && !restored.walk?.mobile ? { name: restored.cust.name || '', mobile: restored.cust.mobile || '', address: restored.cust.address || '' } : restored?.walk || emptyWalk);
  const [billNo, setBillNo] = useState('');
  const [remarks, setRemarks] = useState(restored?.remarks || '');
  const [saleMode, setSaleMode] = useState(restored?.saleMode || 'RETAIL');
  const [discount, setDiscount] = useState(restored?.discount || null);
  const [heldId, setHeldId] = useState(restored?.heldId || null);
  const [idem, setIdem] = useState(restored?.idem || uid());
  const [entry, setEntry] = useState(emptyEntry);
  const [q, setQ] = useState(''), [hi, setHi] = useState(0), [dropPos, setDropPos] = useState(null);
  const [dlg, setDlg] = useState(null);
  const [fit, setFit] = useState(MIN_ROWS); // rows that fit in the sheet at the current window size
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);
  const [scale, setScale] = useState({ connected: false, grams: 0, stable: false, error: 'Connecting…' });
  const [auto, setAuto] = useState(false);
  const [shift, setShift] = useState(null);
  const [msg, setMsg] = useState('');
  const [payMode, setPayMode] = useState('CASH'), [recv, setRecv] = useState('');
  const [printer, setPrinter] = useState(null);
  const qRef = useRef(null), wRef = useRef(null), rRef = useRef(null), gridRef = useRef(null), recvRef = useRef(null), saveRef = useRef(null), mobRef = useRef(null), mobLatest = useRef('');
  const loadNo = () => get('/bills/next-number').then((r) => setBillNo(r.no || '')).catch(() => {});
  useEffect(() => { loadNo(); return bus.on('sync', loadNo); }, []);
  const byId = useMemo(() => new Map(products.map((p) => [p._id, p])), [products]);
  const active = useMemo(() => products.filter((p) => p.active), [products]);
  const payModes = conf.billing.paymentModes && conf.billing.paymentModes.length ? conf.billing.paymentModes : ['CASH', 'UPI'];
  // a split payment is only offered when the shop takes more than two modes (cash + UPI only: pick one of them)
  const canMix = payModes.length > 2;
  useEffect(() => { if (payMode !== 'MIXED' ? !payModes.includes(payMode) : !canMix) setPayMode(payModes[0]); }, [payModes.join()]);

  useEffect(() => connectScale(setScale), []);
  useEffect(() => { get('/shift').then(setShift).catch(() => {}); }, []);
  useEffect(() => { try { localStorage.setItem(draftKey(terminal?.code), JSON.stringify({ lines, cust, walk, remarks, saleMode, discount, heldId, idem })); } catch (e) {} }, [lines, cust, walk, remarks, saleMode, discount, heldId, idem]);
  // receipt printer status for the header (desktop app only; the browser uses its own print dialog)
  useEffect(() => {
    if (!(window.pos && window.pos.printers)) { setPrinter({ ok: true, text: 'Browser print' }); return; }
    const want = terminal?.print?.printer || '';
    window.pos.printers().then((l) => { const ok = want ? l.some((x) => x.name === want) : l.length > 0; setPrinter({ ok, text: ok ? 'Printer ready' : want ? 'Printer not found' : 'No printer installed' }); }).catch(() => setPrinter({ ok: false, text: 'Printer status unknown' }));
  }, [terminal?.print?.printer]);
  // manager price change: never touches existing lines; tells the operator
  useEffect(() => bus.on('product:price-updated', (d) => {
    if (lines.some((l) => l.productId === d.productId)) toast(`${d.name} is already on this bill at the old rate. New rate ₹${rs(d.rate)} applies to new entries only.`, 'warn');
    setEntry((e) => (e.p && e.p._id === d.productId && !e.rateEdited ? { ...e, p: { ...e.p, rate: d.rate }, rateText: (d.rate / 100).toFixed(2) } : e));
  }), [lines]);

  const t = useMemo(() => totals(lines, discount, conf.billing, (id) => byId.get(id)?.taxRate || 0), [lines, discount, conf, byId]);
  const results = useMemo(() => {
    const s = q.trim().toLowerCase(); if (!s) return [];
    const exact = active.filter((p) => p.code.toLowerCase() === s || p.barcode === q.trim());
    const rest = active.filter((p) => !exact.includes(p) && (p.name.toLowerCase().includes(s) || p.localName.toLowerCase().includes(s) || p.code.toLowerCase().startsWith(s) || p.category.toLowerCase().startsWith(s)));
    rest.sort((a, b) => (a.name.toLowerCase().startsWith(s) ? 0 : 1) - (b.name.toLowerCase().startsWith(s) ? 0 : 1) || a.name.localeCompare(b.name));
    return [...exact, ...rest].slice(0, 12);
  }, [q, active]);
  useEffect(() => setHi(0), [q]);
  // the product list floats over the sheet (the sheet scrolls, so it cannot live inside the cell)
  useLayoutEffect(() => {
    if (!results.length || !qRef.current) { setDropPos(null); return; }
    const r = qRef.current.getBoundingClientRect(), below = window.innerHeight - r.bottom;
    setDropPos(below < 260 && r.top > below ? { left: r.left, bottom: window.innerHeight - r.top + 2 } : { left: r.left, top: r.bottom + 2 });
  }, [results]);

  const focusQ = () => setTimeout(() => { const el = qRef.current || wRef.current; el && el.focus(); }, 0);
  const choose = (p) => {
    if (!p) return;
    // synchronous render + focus so fast typists / barcode scanners never type into the wrong box
    flushSync(() => { setEntry({ p, qtyText: isWeighed(p.unit) ? '' : '1', rateText: (p.rate / 100).toFixed(2), tareText: '', rateEdited: false }); setQ(''); setMsg(''); setSel(-1); });
    if (wRef.current) { wRef.current.focus(); wRef.current.select(); }
  };
  const clearEntry = () => { setEntry(emptyEntry); setQ(''); setMsg(''); focusQ(); };
  const rateEditable = (p) => p && (!strict || can('rate.override') || p.allowManualRate);
  const tare = () => { const x = entry.tareText.trim() ? parseQty('KG', entry.tareText) : 0; return Number.isFinite(x) && x >= 0 ? x : NaN; };
  const net = () => scale.grams - (tare() || 0);
  /** add line. fromScale: use the signed scale reading */
  const addLine = useCallback((fromScale) => {
    const p = entry.p; if (!p) { setMsg(`Select a product first (${hint('productSearch')})`); focusQ(); return false; }
    const rate = paise(entry.rateText);
    if (!Number.isFinite(rate) || rate < 0) { setMsg('Enter a valid rate'); return false; }
    if (rate !== p.rate && !rateEditable(p)) { setMsg('Rate change needs manager'); return false; }
    let qty, src = 'COUNT', reading = null; const tr = tare();
    if (!Number.isFinite(tr)) { setMsg('Tare is invalid'); return false; }
    if (isWeighed(p.unit)) {
      if (fromScale) {
        if (!scale.connected) { setMsg('Scale not connected. Type the weight (manual).'); return false; }
        if (scale.error) { setMsg(scale.error); return false; }
        if (!scale.stable) { setMsg('Weight not stable — wait'); return false; }
        qty = net(); if (!(qty > 0)) { setMsg('Net weight must be more than zero'); return false; }
        src = 'SCALE'; reading = scale.reading || null;
      } else {
        qty = parseQty(p.unit, entry.qtyText);
        if (!(qty > 0)) { setMsg('Enter weight in kg, e.g. 18.450'); return false; }
        if (strict && p.allowManualWeight === false && !can('weight.manual')) { setMsg(`${p.name} must be weighed on the scale (manager can override)`); }
        src = 'MANUAL';
      }
    } else {
      qty = parseQty(p.unit, entry.qtyText || '1');
      if (!(qty > 0)) { setMsg('Enter quantity'); return false; }
    }
    const line = { key: uid(), productId: p._id, code: p.code, name: p.name, unit: p.unit, qty, rate, tare: isWeighed(p.unit) ? tr : 0, src, reading, quotedAt: new Date().toISOString(), rateManual: rate !== p.rate };
    flushSync(() => { setLines((a) => [...a, line]); setSel(-1); setEntry(emptyEntry); setMsg(''); });
    qRef.current && qRef.current.focus();
    return true;
  }, [entry, scale, user, strict]);

  // existing v2 behaviour: auto-capture stable weight, re-arm when scale is emptied
  const armed = useRef(true);
  useEffect(() => {
    if (scale.grams < 20) { armed.current = true; return; }
    if (!auto || !armed.current || !entry.p || !isWeighed(entry.p.unit) || !scale.stable || !scale.connected || entry.qtyText) return;
    if (net() > 0) { armed.current = false; addLine(true); }
  }, [scale, auto, entry]);

  const newBill = (force) => {
    if (lines.length && !force) { setDlg({ type: 'confirmNew' }); return; }
    setLines([]); setCust(null); setWalk(emptyWalk); setRemarks(''); setSaleMode('RETAIL'); setDiscount(null); setHeldId(null); setIdem(uid()); setEntry(emptyEntry); setSel(-1); setMsg(''); setQ(''); setPayMode('CASH'); setRecv(''); focusQ();
  };
  const payload = (payments, tendered, approvals) => ({
    idemKey: idem, heldId, customerId: cust ? cust._id : null, customer: walk, remarks, saleMode, discount, payments, tendered, approvals,
    items: lines.map((l) => ({ productId: l.productId, qty: l.qty, rate: l.rate, tare: l.tare, reading: l.reading, quotedAt: l.quotedAt })),
  });
  const doPrint = async (b, duplicate = false) => {
    try {
      const paper = terminal?.print?.paper || conf.print.paper;
      const html = receiptHtml(b, conf.shop, { paper, duplicate, showGst: conf.print.showGstBreakup });
      const r = await printHtml(html, { printer: terminal?.print?.printer || '', copies: terminal?.print?.copies || conf.print.copies, silent: conf.print.silent, paper, save: conf.print.saveCopy, fileName: b.no + (duplicate ? '-duplicate' : '') });
      if (r && r.saved && conf.print.saveCopy === 'SAVE_ONLY') toast('Bill saved on this PC: ' + r.saved, 'ok');
      await post(`/bills/${b._id}/printed`, { reprint: duplicate }).catch(() => {});
    } catch (e) { toast(e.message, 'error'); }
  };
  const save = async (payments, tendered) => {
    if (busy) return; if (!lines.length) { setMsg('Add at least one item'); return; }
    if (!serverOk) { toast('Server connection lost. Bill kept on screen — try again when connected.', 'error'); return; }
    setBusy(true);
    try {
      const r = await withApprovals((ap) => post('/bills', payload(payments, tendered, ap)));
      const b = r.bill;
      setLast(b); setDlg(null);
      toast(`Saved ${b.no} · ₹${rs(b.total)}${b.change ? ' · Change ₹' + rs(b.change) : ''}`, 'ok');
      (r.notes || []).forEach((n) => toast(n, 'warn'));
      newBill(true);
      doPrint(b);
      loadNo();
      get('/shift').then(setShift).catch(() => {});
    } catch (e) { if (!e.cancelled) toast(e.message, 'error'); setMsg(e.message); }
    finally { setBusy(false); }
  };
  const quickSave = () => { if (!lines.length) return setMsg('Add at least one item'); save([{ mode: 'CASH', amount: t.total }], null); };
  const recvP = recv.trim() ? paise(recv) : t.total;
  /** the big Save & Print button: uses the payment chosen in the bill summary */
  const finalSave = () => {
    if (!lines.length) { setMsg('Add at least one item'); focusQ(); return; }
    if (entry.p) { setMsg(`Add or clear draft row ${lines.length + 1} before finalizing`); focusQ(); return; }
    if (payMode === 'MIXED') return setDlg({ type: 'pay' });
    if (payMode === 'CREDIT' && !cust) { setMsg('Credit sale needs an existing customer with credit allowed — enter the mobile number'); return; }
    if (payMode === 'CASH') { if (!Number.isFinite(recvP) || recvP < t.total) { setMsg('Cash received is less than the total'); return; } return save([{ mode: 'CASH', amount: t.total }], recvP); }
    save([{ mode: payMode, amount: t.total }], null);
  };
  /** End: jump to the payment box (cash received) or the Save & Print button; Enter there saves */
  const finalize = () => {
    if (!lines.length) return setMsg('Add at least one item');
    const el = payMode === 'CASH' ? recvRef.current : saveRef.current;
    if (el) { el.focus(); el.select && el.select(); }
  };
  const openPay = () => (lines.length ? setDlg({ type: 'pay' }) : setMsg('Add at least one item'));
  const hold = async () => {
    if (!lines.length) { setDlg({ type: 'held' }); return; }
    try { await post('/held', { items: lines.map((l) => ({ ...l, amount: lineAmount(l.unit, l.qty, l.rate) })), customerId: cust?._id, customer: walk, discount, note: remarks.slice(0, 80), saleMode }); toast(`Bill saved to draft. ${hint('recall')} to open it again.`, 'ok'); newBill(true); return true; }
    catch (e) { toast(e.message, 'error'); return false; }
  };
  const recall = () => (lines.length ? setMsg(`Hold (${hint('held')}) or finish the current bill before recalling another`) : setDlg({ type: 'held' }));
  /** a customer already known for this mobile number: fill the boxes (they stay editable; changes are saved with the bill) */
  const applyCust = (c) => { setCust(c); setWalk({ name: c.name || '', mobile: c.mobile || '', address: c.address || '' }); if (c.type === 'WHOLESALE') setSaleMode('WHOLESALE'); };
  const onMobile = (val) => {
    const m = val.replace(/[^\d+]/g, '').slice(0, 14); mobLatest.current = m;
    if (cust && cust.mobile !== m) { setCust(null); setWalk({ mobile: m, name: '', address: '' }); } // another number = another customer
    else setWalk((w) => ({ ...w, mobile: m }));
    if (/^\d{10}$/.test(m) && can('customer.view')) get('/customers?q=' + m).then((r) => { const c = r.find((x) => x.mobile === m); if (c && mobLatest.current === m) { applyCust(c); toast(`Existing customer: ${c.name}`, 'ok'); } }).catch(() => {});
  };
  const focusCust = () => { if (mobRef.current) { mobRef.current.focus(); mobRef.current.select(); } };
  const resume = async (h) => {
    try {
      const x = await post(`/held/${h._id}/resume`);
      setLines(x.items.map((l) => ({ ...l, key: uid(), code: byId.get(l.productId)?.code || '' })));
      setDiscount(x.discount); setHeldId(null); setIdem(uid()); setRemarks(x.note || ''); setSaleMode(SALE_MODES[x.saleMode] ? x.saleMode : 'RETAIL');
      const known = x.customerId ? await get('/customers/' + x.customerId).catch(() => null) : null;
      setCust(known); setWalk({ name: x.customer?.name || known?.name || '', mobile: x.customer?.mobile || known?.mobile || '', address: x.customer?.address || known?.address || '' });
      setDlg(null); focusQ();
    } catch (e) { toast(e.message, 'error'); }
  };
  const custKey = (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); focusQ(); } };
  const delLine = (i = sel) => { if (i < 0 || !lines[i]) return; setDlg({ type: 'confirmDel', i }); };
  const editQty = (i = sel) => { if (!lines[i]) return setMsg('Select a row (↑/↓) first, then change its quantity'); setSel(i); setDlg({ type: 'qty', i }); };
  /** a typed quantity replaces the scale reading, so the row is marked MANUAL like any typed weight */
  const setQty = (i, qty) => setLines((a) => a.map((l, k) => (k !== i || l.qty === qty ? l : { ...l, qty, ...(isWeighed(l.unit) ? { src: 'MANUAL', reading: null } : {}) })));
  const reprintLast = async () => {
    if (!last) { setDlg({ type: 'history' }); return; }
    doPrint(last, (last.printCount || 0) > 0 || true);
  };
  const nextProduct = () => { const i = active.findIndex((p) => p._id === entry.p?._id); choose(active[(i + 1) % active.length]); };

  useEffect(() => pushScope({
    newBill: () => newBill(), productSearch: clearEntry, customerSearch: focusCust, items: () => setDlg({ type: 'items' }),
    capture: () => addLine(true), addItem: () => addLine(!entry.qtyText), save: quickSave, discount: () => setDlg({ type: 'discount' }),
    payment: openPay, complete: openPay, finalize,
    print: reprintLast, held: hold, recall, history: () => setDlg({ type: 'history' }), manualWeight: () => { if (entry.p) { wRef.current && wRef.current.focus(); setMsg('Type weight in kg and press Enter'); } },
    rate: () => (entry.p && rateEditable(entry.p) ? rRef.current.focus() : setMsg('Rate is fixed (manager can change)')), quantity: () => editQty(), nextProduct,
    refresh: () => bus.emit('refresh'), deleteLine: () => delLine(),
  }), [entry, lines, sel, scale, last, t, discount, cust, walk, remarks, saleMode, payMode, recv, busy, serverOk]);

  const selMove = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, lines.length - 1)); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s <= 0 ? (lines.length ? 0 : -1) : s - 1)); return true; }
    return false;
  };
  const onQKey = (e) => {
    if (results.length && e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, results.length - 1)); }
    else if (results.length && e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (selMove(e)) { /* row selection */ }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[hi]) choose(results[hi]); else if (q.trim()) setMsg(`No product matches "${q}"`); }
    else if (e.key === 'Escape') { setQ(''); setSel(-1); }
    else if (e.key === 'Delete' && !q && sel >= 0) { e.preventDefault(); delLine(); }
  };
  const onWKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addLine(isWeighed(entry.p?.unit) && !entry.qtyText.trim()); }
    else if (e.key === 'Escape') { e.preventDefault(); clearEntry(); }
    else if (!entry.qtyText && selMove(e)) { /* row selection */ }
    else if (e.key === 'Delete' && !entry.qtyText && sel >= 0) { e.preventDefault(); delLine(); }
  };
  const recvKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); finalSave(); } else if (e.key === 'Escape') { e.preventDefault(); focusQ(); } };
  useEffect(() => { if (!gridRef.current) return; const r = gridRef.current.querySelector(sel >= 0 ? `tr[data-i="${sel}"]` : 'tr.draft'); r && r.scrollIntoView({ block: 'nearest' }); }, [sel, lines.length]);
  useEffect(() => { focusQ(); }, []);
  useLayoutEffect(() => {
    const el = gridRef.current; if (!el) return;
    const calc = () => { const head = el.querySelector('thead'), row = el.querySelector('tr.draft'); if (head && row && row.offsetHeight) setFit(Math.max(MIN_ROWS, Math.floor((el.clientHeight - head.offsetHeight) / row.offsetHeight))); };
    calc(); const ro = new ResizeObserver(calc); ro.observe(el); return () => ro.disconnect();
  }, []);

  const p = entry.p, weighed = p && isWeighed(p.unit);
  const draftRate = p ? paise(entry.rateText) : NaN;
  const draftQty = !p ? 0 : weighed ? (entry.qtyText ? parseQty(p.unit, entry.qtyText) : Math.max(0, net())) : parseQty(p.unit, entry.qtyText || '1');
  const preview = p && Number.isFinite(draftRate) && draftQty > 0 ? lineAmount(p.unit, draftQty, draftRate) : 0;
  const draftNo = lines.length + 1, selLine = sel >= 0 ? lines[sel] : null;
  const fx = selLine ? `${selLine.name} · ${qtyStr(selLine.unit, selLine.qty)} ${unitLabel(selLine.unit)} × ₹${rs(selLine.rate)} = ₹${rs(t.gross[sel] || 0)}`
    : p ? `${p.name} · ${draftQty > 0 ? qtyStr(p.unit, draftQty) : weighed ? '0.000' : '0'} ${unitLabel(p.unit)} × ₹${Number.isFinite(draftRate) ? rs(draftRate) : '—'} = ₹${rs(preview)}` : '';
  const kg = lines.reduce((s, l) => s + (l.unit === 'KG' ? l.qty : 0), 0);
  const scaleOk = scale.connected && !scale.error;
  const discPct = (i) => (t.gross[i] ? ((t.ld[i] || 0) * 100 / t.gross[i]).toFixed(2) : '0.00');
  const change = Number.isFinite(recvP) && recvP >= t.total ? recvP - t.total : null;
  const closeDlg = () => { setDlg(null); focusQ(); };

  return <div className="pos">
    <div className="se-head">
      <img className="se-logo" src="./logo.png" alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
      <div className="se-shop">
        <div className="se-title">Sale Entry</div>
        <div className="se-sub">{conf.shop.tagline || conf.shop.name}</div>
        <div className="se-addr">{[conf.shop.address, conf.shop.city].filter(Boolean).join(', ')}</div>
        {conf.shop.phone && <div className="se-addr">Phone: {conf.shop.phone}</div>}
      </div>
      <div className="se-meta">
        <div><small>Bill no</small><b className="billno">{billNo || '—'}</b></div>
        <div><small>Counter · Operator</small><b>{terminal ? terminal.code : '—'} · {user.name}</b></div>
        <div><small>Sale mode</small><select value={saleMode} tabIndex={-1} onChange={(e) => { setSaleMode(e.target.value); focusQ(); }}>{Object.entries(SALE_MODES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div><small>Date</small><b>{new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</b></div>
      </div>
      <div className="se-pills">
        <span className={'pill' + (serverOk ? '' : ' bad')}>{serverOk ? 'Store server connected' : 'Store server disconnected'}</span>
        <span className={'pill' + (scaleOk ? '' : ' bad')}>{scaleOk ? `Scale connected${scale.transport === 'mock' ? ' (simulator)' : ''}` : scale.connected ? scale.error : 'Scale disconnected'}</span>
        {printer && <span className={'pill' + (printer.ok ? '' : ' bad')}>{printer.text}</span>}
      </div>
      {onLogout && <button className="se-logout" tabIndex={-1} onClick={() => (lines.length ? setDlg({ type: 'confirmLogout' }) : onLogout())}>Logout</button>}
    </div>
    <div className="se-cust">
      <div className="se-cust-h"><b>Customer details</b>
        <span className="mut">{cust ? <>Existing customer {cust.code} · Balance ₹{rs(cust.balance || 0)}{cust.creditAllowed ? ` / Limit ₹${rs(cust.creditLimit || 0)}` : ' · no credit'} · changes are saved with the bill</>
          : /^\d{10}$/.test(walk.mobile) ? 'New customer · saved automatically with this bill' : `Optional for walk-in cash sales · ${hint('customerSearch')}`}</span></div>
      <div className="se-cust-f">
        <Field label="Mobile number"><input ref={mobRef} value={walk.mobile} placeholder="Enter mobile number" inputMode="numeric" onChange={(e) => onMobile(e.target.value)} onKeyDown={custKey} /></Field>
        <Field label="Customer name"><input value={walk.name} placeholder="Walk-in customer" maxLength={80} onChange={(e) => setWalk({ ...walk, name: e.target.value })} onKeyDown={custKey} /></Field>
        <Field label="Customer address"><input value={walk.address} placeholder="Enter customer address" maxLength={200} onChange={(e) => setWalk({ ...walk, address: e.target.value })} onKeyDown={custKey} /></Field>
        <Field label="Remarks"><input value={remarks} maxLength={200} placeholder="Add a note for this bill" onChange={(e) => setRemarks(e.target.value)} onKeyDown={custKey} /></Field>
      </div>
    </div>
    <div className="se-body">
      <div className="sheet">
        <div className="sheet-head">
          <div className="sh-t"><b>Sale items</b><small>Select product → capture weight → Enter adds row</small></div>
          <div className="sh-r">
            <label className="chk"><input type="checkbox" tabIndex={-1} checked={auto} onChange={(e) => { setAuto(e.target.checked); focusQ(); }} /> Auto-capture</label>
            <span className={'spill ' + (scaleOk ? (scale.stable ? 'st' : 'us') : 'off')}>{scaleOk ? `Scale ${scale.stable ? 'stable' : 'settling'} · ${(scale.grams / 1000).toFixed(3)} kg${scale.pcs != null ? ` · ${scale.pcs} pcs` : ''}` : 'Scale off · type the weight'}</span>
          </div>
        </div>
        <div className="fxbar">
          <span className="cellref">A{selLine ? sel + 1 : draftNo}</span><span className="fx">fx</span><span className="fxt">{fx}</span>
          {weighed && <label className="tare">Tare <input value={entry.tareText} onChange={(e) => setEntry({ ...entry, tareText: e.target.value })} onKeyDown={onWKey} placeholder="0.000" /> kg</label>}
        </div>
        <div className="sheet-grid" ref={gridRef}><table className="sg">
          <colgroup><col style={{ width: 46 }} /><col /><col style={{ width: 132 }} /><col style={{ width: 66 }} /><col style={{ width: 120 }} /><col style={{ width: 84 }} /><col style={{ width: 96 }} /><col style={{ width: 90 }} /><col style={{ width: 124 }} /><col style={{ width: 90 }} /></colgroup>
          <thead>
            <tr className="letters"><th />{COLS.map((c) => <th key={c}>{c}</th>)}</tr>
            <tr className="heads"><th>#</th><th>Product · {hint('productSearch')}</th><th className="n">Quantity</th><th>Unit</th><th className="n">Rate ₹</th><th className="n">Disc %</th><th className="n">Disc ₹</th><th className="n">Tax ₹</th><th className="n">Amount ₹</th><th className="n">Action</th></tr>
          </thead>
          <tbody>
            {lines.map((l, i) => <tr key={l.key} data-i={i} className={i === sel ? 'sel' : ''} onClick={() => setSel(i)}>
              <td className="rn">{i + 1}</td>
              <td><b>{l.name}</b><small>{l.code}</small>{l.rateManual && <span className="tag">RATE</span>}{l.src === 'MANUAL' && <span className="tag">MANUAL</span>}</td>
              <td className="n qedit" title={`Click to change the quantity (${hint('quantity')})`} onClick={(e) => { e.stopPropagation(); editQty(i); }}>{qtyStr(l.unit, l.qty)}</td><td>{unitLabel(l.unit)}</td><td className="n">{rs(l.rate)}</td><td className="n">{discPct(i)}</td><td className="n">{rs(t.ld[i] || 0)}</td><td className="n">{rs(t.lt[i] || 0)}</td><td className="n amt">{rs(t.gross[i] || 0)}</td>
              <td className="act"><button className="ico" tabIndex={-1} title="Remove row (Delete)" onMouseDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); delLine(i); }}><Trash /></button></td></tr>)}
            <tr className="draft">
              <td className="rn">{draftNo}</td>
              <td className="pcell">{p
                ? <div className="pname" onClick={clearEntry} title={`Change product (${hint('productSearch')})`}><b>{p.name}</b><small>{p.code}</small><small className="dtag">DRAFT</small></div>
                : <input ref={qRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onQKey} placeholder="Type product name, code or barcode…" autoComplete="off" />}</td>
              <td className="n"><input ref={wRef} className={'n' + (weighed && !entry.qtyText ? ' live' : '')} value={entry.qtyText} placeholder={!p ? '' : weighed ? (scale.connected ? (Math.max(0, net()) / 1000).toFixed(3) : 'type kg') : '1'}
                onChange={(e) => p && setEntry({ ...entry, qtyText: e.target.value })} onKeyDown={onWKey} readOnly={!p} tabIndex={p ? 0 : -1} /></td>
              <td>{p ? unitLabel(p.unit) : ''}</td>
              <td className="n"><input ref={rRef} className="n" value={entry.rateText} readOnly={!rateEditable(p)} tabIndex={rateEditable(p) ? 0 : -1} onChange={(e) => setEntry({ ...entry, rateText: e.target.value, rateEdited: true })}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); wRef.current.focus(); } else if (e.key === 'Escape') { e.preventDefault(); clearEntry(); } }} /></td>
              <td className="n">{p ? '0.00' : ''}</td><td className="n">{p ? '0.00' : ''}</td><td className="n">{p ? '0.00' : ''}</td><td className="n amt">{p ? rs(preview) : ''}</td>
              <td className="act">{p && <button className="lnk" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => addLine(weighed && !entry.qtyText.trim())}>↵ Enter</button>}</td>
            </tr>
            {Array.from({ length: Math.max(0, fit - draftNo) }, (_, i) => <tr key={'f' + i} className="fill"><td className="rn">{draftNo + 1 + i}</td><td /><td /><td /><td /><td /><td /><td /><td /><td /></tr>)}
          </tbody></table></div>
        <div className="sheet-info">{msg ? <span className="err">{msg}</span>
          : p ? <span>Row {draftNo} is the live entry. Press Enter to add ₹{rs(preview)} to the bill{lines.length ? `; current total includes row${lines.length > 1 ? 's 1–' + lines.length : ' 1'} only` : ''}.</span>
            : <span>Type a product and press Enter · Enter on the weight takes the scale weight, or type it · ↑ ↓ select row · click quantity or {hint('quantity')} to change it · Delete removes{strict ? ' · overrides need permission' : ''}</span>}
          <b className="cnt">{lines.length} line{lines.length === 1 ? '' : 's'} · {(kg / 1000).toFixed(3)} kg</b></div>
      </div>
      <div className="sum">
        <h3>Bill summary</h3>
        <div className="sum-r"><span>Goods value</span><b>₹{rs(t.sub)}</b></div>
        <div className="sum-r clk" onClick={() => setDlg({ type: 'discount' })} title={`Change discount (${hint('discount')})`}><span>Discount{t.discount ? ` (${pct(t.discBp)})` : ''}</span><b>₹{rs(t.discount)}</b></div>
        <div className="sum-r"><span>Tax{t.tax && conf.billing.priceIncludesTax ? ' (included)' : ''}</span><b>₹{rs(t.tax)}</b></div>
        <div className="sum-r"><span>Round off</span><b>₹{rs(t.roundOff)}</b></div>
        <div className="netl">NET PAYABLE</div><div className="net">₹{rs(t.total)}</div>
        <label className="payrow"><span>Payment</span><select value={payMode} tabIndex={-1} onChange={(e) => { setPayMode(e.target.value); setMsg(''); focusQ(); }}>{payModes.map((m) => <option key={m} value={m}>{modeLabel(m)}</option>)}{canMix && <option value="MIXED">Mixed</option>}</select></label>
        {payMode === 'CASH' ? <>
          <div className="sum-r"><span>Received</span><input ref={recvRef} className="recv n" value={recv} placeholder={'₹' + rs(t.total)} onChange={(e) => setRecv(e.target.value)} onKeyDown={recvKey} tabIndex={-1} /></div>
          <div className="sum-r"><span>Change</span><b>{change == null ? '—' : '₹' + rs(change)}</b></div></>
          : <div className="mut payhint">{payMode === 'CREDIT' ? (cust ? `${cust.name}: outstanding ₹${rs(cust.balance || 0)}` : 'Enter the mobile number of an existing customer first.') : payMode === 'MIXED' ? 'The split between payment modes is entered when you save.' : `Reference / UTR can be added with ${hint('payment')}.`}</div>}
        <button ref={saveRef} className="b savebtn" disabled={busy} onClick={finalSave} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); focusQ(); } }}>{busy ? 'Saving…' : <>{hint('finalize')} → Enter · Save &amp; Print</>}</button>
        <div className="mut">{p ? `Add or clear draft row ${draftNo} before finalizing. ` : ''}Save the bill once, then it is sent to the receipt printer.</div>
        {last && <div className="last">Last bill <b>{last.no}</b> · ₹{rs(last.total)} {last.mode}{last.change ? ` · change ₹${rs(last.change)}` : ''}</div>}
      </div>
    </div>
    <div className="keybar">
      <Key k="Enter" onClick={() => addLine(weighed && !entry.qtyText.trim())}>Add item</Key>
      <Key k={hint('customerSearch')} onClick={focusCust}>Customer</Key>
      <Key k={hint('productSearch')} onClick={clearEntry}>Product</Key>
      <Key k={hint('items')} onClick={() => setDlg({ type: 'items' })}>All items</Key>
      <Key k={hint('payment')} onClick={openPay}>Payment</Key>
      <Key k={hint('held')} onClick={hold}>Hold</Key>
      <Key k={hint('recall')} onClick={recall}>Recall</Key>
      <Key k="Esc" onClick={clearEntry} short="Back">Cancel / Back</Key>
      <Key k={`${hint('finalize')} → Enter`} onClick={finalSave} short="Save">Save &amp; Print</Key>
      <span className="gap" />
      <Key sec k={hint('newBill')} onClick={() => newBill()} short="New">New bill</Key>
      <Key sec k={hint('discount')} onClick={() => setDlg({ type: 'discount' })} short="Disc">Discount</Key>
      <Key sec k={hint('print')} onClick={reprintLast} short="Reprint">Print last</Key>
      <Key sec k={hint('history')} onClick={() => setDlg({ type: 'history' })}>History</Key>
      <Key sec k="⏱" onClick={() => setDlg({ type: 'shift' })}>Shift{shift ? ' open' : ''}</Key>
      <Key sec k="₹" onClick={() => setDlg({ type: 'rates' })} short="Rates">Rate changes</Key>
      {onExit && <Key sec k="⌂" onClick={onExit}>Manager</Key>}
    </div>
    {dropPos && results.length > 0 && <div className="drop" style={{ position: 'fixed', ...dropPos }}>{results.map((r, i) => <div key={r._id} className={'dr' + (i === hi ? ' on' : '')} onMouseDown={(e) => { e.preventDefault(); choose(r); }}>
      <span className="code">{r.code}</span><span className="nm">{r.name}{r.localName && <small> {r.localName}</small>}</span><span className="n">₹{rs(r.rate)}/{unitLabel(r.unit)}</span><span className="n mut">{qtyStr(r.unit, r.stock)}</span></div>)}</div>}
    {dlg?.type === 'pay' && <PaymentDialog total={t.total} conf={conf} cust={cust} busy={busy} init={payMode} onClose={closeDlg} onSave={save} />}
    {dlg?.type === 'items' && <ItemsDialog products={active} onClose={closeDlg} onPick={(x) => { setDlg(null); choose(x); }} />}
    {dlg?.type === 'discount' && <DiscountDialog cur={discount} sub={t.sub} limit={conf.discountLimits[user.role] || 0} onClose={closeDlg} onSet={(d) => { setDiscount(d); closeDlg(); }} />}
    {dlg?.type === 'held' && <HeldDialog onClose={closeDlg} onResume={resume} />}
    {dlg?.type === 'history' && <HistoryDialog onClose={closeDlg} onPrint={(b) => doPrint(b, true)} />}
    {dlg?.type === 'shift' && <ShiftDialog shift={shift} onClose={closeDlg} onChange={(s) => setShift(s)} />}
    {dlg?.type === 'rates' && <Modal title="Rate changes — all products" onClose={closeDlg} width={820}><RateChanges bus={bus} products={products} /></Modal>}
    {dlg?.type === 'qty' && <QtyDialog line={lines[dlg.i]} onClose={closeDlg} onSet={(qty) => { setQty(dlg.i, qty); closeDlg(); }} />}
    {dlg?.type === 'confirmDel' && <Confirm text={`Remove ${lines[dlg.i]?.name} from the bill?`} onNo={closeDlg} onYes={() => { setLines((a) => a.filter((_, i) => i !== dlg.i)); setSel(-1); closeDlg(); }} />}
    {dlg?.type === 'confirmNew' && <Modal title="Start a new bill?" onClose={closeDlg} width={460}>
      <p>This bill has {lines.length} item{lines.length === 1 ? '' : 's'} (₹{rs(t.total)}) and is not saved yet.</p>
      <div className="row-r"><button onClick={closeDlg}>Go back (Esc)</button><button className="d" onClick={() => { setDlg(null); newBill(true); }}>Discard</button>
        <button className="b" data-autofocus onClick={async () => { if (await hold()) setDlg(null); }}>Save to draft (Enter)</button></div>
      <div className="mut">A draft is kept on the server; open it again with {hint('recall')} Recall.</div></Modal>}
    {dlg?.type === 'confirmLogout' && <Confirm text={`This bill has ${lines.length} item${lines.length === 1 ? '' : 's'} and is not saved. It stays on this counter as an open bill. Log out?`} onNo={closeDlg} onYes={() => { setDlg(null); onLogout(); }} />}
  </div>;
}

function PaymentDialog({ total, conf, cust, busy, init, onClose, onSave }) {
  const modes = conf.billing.paymentModes && conf.billing.paymentModes.length ? conf.billing.paymentModes : ['CASH', 'UPI'];
  const all = modes.length > 2 ? [...modes, 'MIXED'] : modes;
  const [mode, setMode] = useState(all.includes(init) ? init : all[0]), [recv, setRecv] = useState(''), [ref, setRef] = useState(''), [mix, setMix] = useState({}), [err, setErr] = useState('');
  const recvP = recv.trim() ? paise(recv) : total;
  const mixSum = Object.values(mix).reduce((s, x) => s + (paise(x) || 0), 0);
  const submit = () => {
    setErr('');
    if (mode === 'MIXED') {
      const list = Object.entries(mix).map(([m, x]) => ({ mode: m, amount: paise(x) })).filter((x) => x.amount > 0);
      if (list.some((x) => !Number.isFinite(x.amount))) return setErr('Invalid amount');
      if (mixSum !== total) return setErr(`Split ₹${rs(mixSum)} must equal total ₹${rs(total)}`);
      return onSave(list, null);
    }
    if (mode === 'CREDIT' && !cust) return setErr('Credit needs an existing customer: enter the mobile number on the bill first');
    if (mode === 'CASH') { if (!Number.isFinite(recvP) || recvP < total) return setErr('Cash received is less than total'); return onSave([{ mode, amount: total }], recvP); }
    onSave([{ mode, amount: total, ref }], null);
  };
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    else if (e.altKey && /^[1-9]$/.test(e.key)) { e.preventDefault(); const m = all[+e.key - 1]; if (m) setMode(m); }
    else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && e.target.tagName !== 'INPUT') { e.preventDefault(); const i = all.indexOf(mode); setMode(all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length]); }
  };
  return <Modal title="Payment" onClose={onClose} width={520}><div onKeyDown={onKey}>
    <div className="paytotal">Total <b>₹{rs(total)}</b></div>
    <div className="modes">{all.map((m, i) => <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}><span className="k">Alt+{i + 1}</span> {m}</button>)}</div>
    {mode === 'CASH' && <><Field label="Cash received ₹ (blank = exact)"><input data-autofocus value={recv} onChange={(e) => setRecv(e.target.value)} placeholder={rs(total)} /></Field>
      <div className="change">Return: <b>₹{Number.isFinite(recvP) && recvP >= total ? rs(recvP - total) : '—'}</b></div></>}
    {['UPI', 'CARD', 'BANK'].includes(mode) && <Field label="Reference / UTR (optional)"><input data-autofocus value={ref} onChange={(e) => setRef(e.target.value)} /></Field>}
    {mode === 'CREDIT' && <div className="warnbox">{cust ? `${cust.name}: outstanding ₹${rs(cust.balance || 0)}, limit ₹${rs(cust.creditLimit || 0)}${cust.creditAllowed ? '' : ' — credit NOT allowed'}` : 'Credit needs an existing customer: enter the mobile number on the bill first.'}<input data-autofocus style={{ opacity: 0, height: 1 }} readOnly /></div>}
    {mode === 'MIXED' && <div className="mix">{modes.map((m, i) => <Field key={m} label={m}><input data-autofocus={i === 0 ? true : undefined} value={mix[m] || ''} onChange={(e) => setMix({ ...mix, [m]: e.target.value })} /></Field>)}
      <div className={mixSum === total ? 'okmsg' : 'err'}>Split ₹{rs(mixSum)} / ₹{rs(total)} {mixSum !== total && `(diff ₹${rs(total - mixSum)})`}</div></div>}
    <Msg m={err} />
    <div className="row-r"><button onClick={onClose}>Cancel (Esc)</button><button className="b" disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Save & Print (Enter)'}</button></div>
  </div></Modal>;
}

/** every active item with its rate and stock; type to filter, Enter puts the item on the bill */
function ItemsDialog({ products, onClose, onPick }) {
  const [q, setQ] = useState(''), [hi, setHi] = useState(0), box = useRef(null);
  const list = useMemo(() => { const s = q.trim().toLowerCase(); return products.filter((p) => !s || (p.name + ' ' + p.code + ' ' + p.localName + ' ' + p.category + ' ' + p.barcode).toLowerCase().includes(s)); }, [q, products]);
  useEffect(() => setHi(0), [q]);
  useEffect(() => { const r = box.current && box.current.querySelector('tr.sel'); r && r.scrollIntoView({ block: 'nearest' }); }, [hi]);
  const key = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, list.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (list[hi]) onPick(list[hi]); }
  };
  return <Modal title={`All items (${hint('items')})`} onClose={onClose} width={860}><div onKeyDown={key}>
    <input data-autofocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, code, category or barcode…" autoComplete="off" />
    <div className="list tall" ref={box}><table className="tbl"><thead><tr><th>Code</th><th>Item</th><th>Category</th><th>Unit</th><th className="n">Rate ₹</th><th className="n">Stock</th></tr></thead>
      <tbody>{list.map((p, i) => <tr key={p._id} className={i === hi ? 'sel' : ''} style={{ cursor: 'pointer' }} onClick={() => onPick(p)}>
        <td>{p.code}</td><td>{p.name}{p.localName && <small className="mut"> {p.localName}</small>}</td><td>{p.category}</td><td>{unitLabel(p.unit)}</td><td className="n">{rs(p.rate)}</td>
        <td className={'n' + (p.stock <= 0 ? ' bad' : '')}>{qtyStr(p.unit, p.stock)} {unitLabel(p.unit)}</td></tr>)}
        {!list.length && <tr><td colSpan={6} className="empty">No item matches</td></tr>}</tbody></table></div>
    <div className="mut">{list.length} item{list.length === 1 ? '' : 's'} · ↑↓ select · Enter or click adds it to the bill · stock in red = none left</div></div></Modal>;
}
function DiscountDialog({ cur, sub, limit, onClose, onSet }) {
  const [type, setType] = useState(cur?.type || 'AMT'), [val, setVal] = useState(cur ? (cur.type === 'PCT' ? (cur.value / 100).toString() : (cur.value / 100).toFixed(2)) : '');
  const v = paise(val); const amt = type === 'PCT' ? Math.round(sub * (v || 0) / 10000) : v || 0;
  return <Modal title={`Discount (${hint('discount')})`} onClose={onClose} width={380}><form onSubmit={(e) => { e.preventDefault(); if (!val.trim()) return onSet(null); if (!Number.isFinite(v) || v < 0) return; onSet({ type, value: v }); }}>
    <div className="modes"><button type="button" className={type === 'AMT' ? 'on' : ''} onClick={() => setType('AMT')}>₹ Amount</button><button type="button" className={type === 'PCT' ? 'on' : ''} onClick={() => setType('PCT')}>% Percent</button></div>
    <Field label={type === 'PCT' ? 'Discount %' : 'Discount ₹'}><input data-autofocus value={val} onChange={(e) => setVal(e.target.value)} /></Field>
    <div className="mut">= ₹{rs(amt)} on ₹{rs(sub)}. Your limit: {pct(limit)} — above that a manager PIN is asked when saving.</div>
    <div className="row-r"><button type="button" onClick={() => onSet(null)}>Remove</button><button className="b">Apply (Enter)</button></div></form></Modal>;
}
function QtyDialog({ line, onClose, onSet }) {
  const [v, setV] = useState(qtyStr(line.unit, line.qty)), [err, setErr] = useState('');
  const w = isWeighed(line.unit);
  const go = (e) => { e.preventDefault(); const n = parseQty(line.unit, v); if (n > 0) onSet(n); else setErr(w ? 'Enter the weight, e.g. 1.250' : 'Enter a whole number'); };
  return <Modal title={`Change quantity — ${line.name}`} onClose={onClose} width={340}><form onSubmit={go}>
    <Field label={`New ${w ? 'weight' : 'quantity'} (${unitLabel(line.unit)}) · rate ₹${rs(line.rate)}`}><input data-autofocus value={v} onChange={(e) => setV(e.target.value)} /></Field>
    {w && line.src === 'SCALE' && <div className="mut">This row came from the scale. A typed weight is marked MANUAL on the bill.</div>}
    <Msg m={err} /><div className="row-r"><button type="button" onClick={onClose}>Cancel (Esc)</button><button className="b">OK (Enter)</button></div></form></Modal>;
}
function HeldDialog({ onClose, onResume }) {
  const [list, setList] = useState(null), [hi, setHi] = useState(0), [err, setErr] = useState('');
  useEffect(() => { get('/held').then(setList).catch((e) => setErr(e.message)); }, []);
  const key = (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, (list || []).length - 1)); } else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); } else if (e.key === 'Enter' && list && list[hi]) { e.preventDefault(); onResume(list[hi]); } };
  return <Modal title={`Held bills (${hint('recall')})`} onClose={onClose} width={640}><div onKeyDown={key} tabIndex={0} data-autofocus className="list">
    <table className="tbl"><thead><tr><th>Time</th><th>Counter</th><th>Operator</th><th>Customer</th><th className="n">Items</th><th className="n">Amount</th></tr></thead>
      <tbody>{(list || []).map((h, i) => <tr key={h._id} className={i === hi ? 'sel' : ''} onDoubleClick={() => onResume(h)}><td>{tm(h.at)}</td><td>{h.terminalCode}</td><td>{h.by}</td><td>{h.customer?.name || 'Walk-in'}</td><td className="n">{h.items.length}</td><td className="n">{rs(h.total)}</td></tr>)}
        {list && !list.length && <tr><td colSpan={6} className="empty">No held bills</td></tr>}</tbody></table></div><Msg m={err} /><div className="mut">↑↓ select · Enter resume</div></Modal>;
}
function HistoryDialog({ onClose, onPrint }) {
  const [all, setAll] = useState(null), [hi, setHi] = useState(0), [q, setQ] = useState(''), [date, setDate] = useState(''), box = useRef(null);
  // newest 500 bills, or every bill of the chosen day; the search box then filters what was loaded
  useEffect(() => { setAll(null); get('/bills?limit=500' + (date ? '&date=' + date : '')).then(setAll).catch(() => setAll([])); }, [date]);
  const day = (b) => new Date(b.at).toLocaleDateString('en-GB');
  const list = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (all || []).filter((b) => { const hay = [b.no, b.customer || 'walk-in', b.customerPhone, b.customerAddress, b.mode, b.status, b.date, day(b), rs(b.total), b.remarks, (b.items || []).map((i) => i.name).join(' ')].join(' ').toLowerCase(); return words.every((w) => hay.includes(w)); });
  }, [all, q]);
  useEffect(() => setHi(0), [q, date]);
  useEffect(() => { const r = box.current && box.current.querySelector('tr.sel'); r && r.scrollIntoView({ block: 'nearest' }); }, [hi]);
  const print = (b) => get('/bills/' + b._id).then(onPrint).catch(() => {});
  const key = (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, list.length - 1)); } else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); } else if (e.key === 'Enter' && list[hi]) { e.preventDefault(); print(list[hi]); } };
  return <Modal title={`Bill history (${hint('history')})`} onClose={onClose} width={900}><div onKeyDown={key}>
    <div className="hsearch"><input data-autofocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search bill number, customer name, mobile, item, amount, date…" autoComplete="off" />
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} title="Show the bills of one day" />{date && <button type="button" onClick={() => setDate('')}>All days</button>}</div>
    <div className="list tall" ref={box}><table className="tbl"><thead><tr><th>Date</th><th>Time</th><th>Bill No</th><th>Customer</th><th>Mobile</th><th className="n">Items</th><th>Mode</th><th className="n">Total</th><th>Status</th></tr></thead>
      <tbody>{list.map((b, i) => <tr key={b._id} className={i === hi ? 'sel' : ''} onClick={() => setHi(i)} onDoubleClick={() => print(b)}><td>{day(b)}</td><td>{tm(b.at)}</td><td>{b.no}</td><td>{b.customer || 'Walk-in'}</td><td>{b.customerPhone}</td><td className="n">{(b.items || []).length}</td><td>{b.mode}</td><td className="n">{rs(b.total)}</td><td>{b.status}</td></tr>)}
        {all && !list.length && <tr><td colSpan={9} className="empty">No bill matches</td></tr>}{!all && <tr><td colSpan={9} className="empty">Loading…</td></tr>}</tbody></table></div>
    <div className="mut">{list.length} bill{list.length === 1 ? '' : 's'} · ↑↓ select · Enter or double-click reprints (marked DUPLICATE, logged)</div></div></Modal>;
}
function ShiftDialog({ shift, onClose, onChange }) {
  const [v, setV] = useState(''), [err, setErr] = useState(''), [res, setRes] = useState(null);
  const go = async (e) => { e.preventDefault(); setErr(''); try { const a = paise(v); if (!Number.isFinite(a)) throw new Error('Enter amount'); if (shift) { const r = await post('/shift/close', { actualCash: a }); setRes(r); onChange(null); } else { await post('/shift/open', { openingCash: a }); onChange(await get('/shift')); onClose(); } } catch (x) { setErr(x.message); } };
  return <Modal title={shift ? 'Close shift' : 'Open shift'} onClose={onClose} width={400}>
    {res ? <div><table className="tot"><tbody><tr><td>Opening</td><td>{rs(res.openingCash)}</td></tr><tr><td>Cash sales</td><td>{rs(res.cashSales)}</td></tr><tr><td>Refunds/cancels</td><td>-{rs(res.cashRefunds + res.cancelledCash)}</td></tr><tr><td>Expected</td><td>{rs(res.expectedCash)}</td></tr><tr><td>Actual</td><td>{rs(res.actualCash)}</td></tr><tr><td><b>Difference</b></td><td><b>{rs(res.difference)}</b></td></tr></tbody></table><div className="row-r"><button className="b" data-autofocus onClick={onClose}>Close</button></div></div>
      : <form onSubmit={go}>{shift && <div className="mut">Opened {tm(shift.openedAt)} · opening ₹{rs(shift.openingCash)} · bills {shift.bills}</div>}
        <Field label={shift ? 'Actual cash in drawer ₹' : 'Opening cash ₹'}><input data-autofocus value={v} onChange={(e) => setV(e.target.value)} /></Field><Msg m={err} />
        <div className="row-r"><button className="b">{shift ? 'Close shift' : 'Open shift'}</button></div></form>}
  </Modal>;
}
