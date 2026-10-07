import { useEffect, useRef, useState, useCallback, createContext, useContext } from 'react';
import { pushScope } from '../lib/shortcuts';
import { post } from '../lib/api';

/** Modal: traps shortcuts (POS keys are inactive while open), Esc closes and returns focus to the caller. */
export function Modal({ title, onClose, children, width = 520, footer }) {
  const ref = useRef(null), prev = useRef(document.activeElement);
  useEffect(() => {
    const off = pushScope({});
    const k = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose && onClose(); } };
    window.addEventListener('keydown', k, true);
    const el = ref.current && ref.current.querySelector('[data-autofocus],input:not([readonly]):not([disabled]),select,button.b');
    el && el.focus(); el && el.select && el.select();
    const p = prev.current;
    return () => { off(); window.removeEventListener('keydown', k, true); setTimeout(() => p && p.focus && document.body.contains(p) && p.focus(), 0); };
  }, []);
  return <div className="ov" onMouseDown={(e) => e.target === e.currentTarget && onClose && onClose()}>
    <div className="modal" ref={ref} style={{ width }} role="dialog" aria-label={title}>
      <div className="mh"><b>{title}</b><button className="x" onClick={onClose} title="Close (Esc)">✕</button></div>
      <div className="mb">{children}</div>{footer && <div className="mf">{footer}</div>}
    </div></div>;
}
export const Field = ({ label, children, w }) => <label className="fld" style={w ? { width: w } : null}><span>{label}</span>{children}</label>;
export const Msg = ({ m, ok }) => (m ? <div className={ok ? 'okmsg' : 'err'}>{m}</div> : null);

/* ---------- toasts ---------- */
const ToastCtx = createContext(() => {});
export function ToastHost({ children }) {
  const [t, setT] = useState([]);
  const push = useCallback((text, kind = 'info') => { const id = Math.random(); setT((x) => [...x.slice(-3), { id, text, kind }]); setTimeout(() => setT((x) => x.filter((y) => y.id !== id)), kind === 'error' ? 6000 : 3500); }, []);
  return <ToastCtx.Provider value={push}>{children}<div className="toasts">{t.map((x) => <div key={x.id} className={'toast ' + x.kind}>{x.text}</div>)}</div></ToastCtx.Provider>;
}
export const useToast = () => useContext(ToastCtx);

/* ---------- manager approval (PIN) ---------- */
const ApprCtx = createContext(null);
export function ApprovalHost({ children }) {
  const [req, setReq] = useState(null);
  const ask = useCallback((action, message, value) => new Promise((resolve) => setReq({ action, message, value, resolve })), []);
  return <ApprCtx.Provider value={ask}>{children}{req && <ApprovalDialog {...req} onDone={(tok) => { req.resolve(tok); setReq(null); }} />}</ApprCtx.Provider>;
}
function ApprovalDialog({ action, message, value, onDone }) {
  const [u, setU] = useState(''), [p, setP] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const go = async (e) => { e.preventDefault(); setBusy(true); try { const r = await post('/approve', { username: u, secret: p, action, value }); onDone(r.approval); } catch (x) { setErr(x.message); setP(''); } finally { setBusy(false); } };
  return <Modal title="Manager approval" onClose={() => onDone(null)} width={380}>
    <form onSubmit={go}><div className="warnbox">{message}</div>
      <Field label="Manager username"><input value={u} onChange={(e) => setU(e.target.value)} data-autofocus autoComplete="off" /></Field>
      <Field label="PIN / password"><input type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="off" /></Field>
      <Msg m={err} /><div className="row-r"><button type="button" onClick={() => onDone(null)}>Cancel (Esc)</button><button className="b" disabled={busy}>Approve (Enter)</button></div></form>
  </Modal>;
}
/** run(fn(approvals)) — retries with manager approval when the server says APPROVAL_REQUIRED */
export function useApprovals() {
  const ask = useContext(ApprCtx);
  return useCallback(async (fn, approvals = {}) => {
    for (let i = 0; i < 5; i++) {
      try { return await fn(approvals); }
      catch (e) {
        if (e.code !== 'APPROVAL_REQUIRED') throw e;
        const tok = await ask(e.extra.action, e.message, e.extra.value);
        if (!tok) { const c = new Error('Cancelled — approval not given'); c.cancelled = true; throw c; }
        approvals = { ...approvals, [e.extra.action]: tok };
      }
    }
    throw new Error('Too many approvals requested');
  }, [ask]);
}
/** simple loader hook */
export function useLoad(fn, deps = []) {
  const [data, setData] = useState(null), [err, setErr] = useState(''), [n, setN] = useState(0);
  useEffect(() => { let on = true; setErr(''); fn().then((d) => on && setData(d)).catch((e) => on && setErr(e.message)); return () => { on = false; }; }, [...deps, n]);
  return [data, () => setN((x) => x + 1), err, setData];
}
export function Confirm({ text, onYes, onNo, yes = 'Yes (Enter)' }) {
  return <Modal title="Confirm" onClose={onNo} width={360}><p>{text}</p><div className="row-r"><button onClick={onNo}>No (Esc)</button><button className="b" data-autofocus onClick={onYes}>{yes}</button></div></Modal>;
}
