import React from 'react';
import {
  AlertTriangle, ArrowLeft, ArrowRight, LoaderCircle, RefreshCw, Search,
} from 'lucide-react';
import { AdminApiError, adminRequest } from '../admin-api.js';

const PAGE_SIZE = 50;
const MOVEMENTS = {
  opening_balance: 'Sold inițial',
  receipt: 'Intrare',
  reservation: 'Rezervare',
  reservation_release: 'Eliberare rezervă',
  sale: 'Vânzare',
  return: 'Retur',
  write_off: 'Casare',
  adjustment: 'Ajustare',
};

const dateTime = (value) => value
  ? new Intl.DateTimeFormat('ro-MD', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : '—';
const signed = (value) => `${Number(value) > 0 ? '+' : ''}${Number(value || 0)}`;

export default function AdminInventoryJournal({ onUnauthorized }) {
  const [items, setItems] = React.useState([]);
  const [pagination, setPagination] = React.useState({ limit: PAGE_SIZE, offset: 0, total: 0 });
  const [type, setType] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const load = React.useCallback(async (offset = 0) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (type) params.set('type', type);
      if (query) params.set('q', query);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const payload = await adminRequest(`/api/admin/inventory-movements?${params}`);
      setItems(payload.items);
      setPagination(payload.pagination);
    } catch (requestError) {
      setError(requestError.message);
      if (requestError instanceof AdminApiError && [401, 403].includes(requestError.status)) onUnauthorized?.();
    } finally {
      setLoading(false);
    }
  }, [from, onUnauthorized, query, to, type]);

  React.useEffect(() => { load(0); }, [load]);
  const reset = () => { setType(''); setSearch(''); setFrom(''); setTo(''); };
  const currentPage = Math.floor(pagination.offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(pagination.total / PAGE_SIZE));

  return (
    <>
      <header className="adm-topbar">
        <div><span>Depozit</span><h1>Jurnal de stoc</h1></div>
        <button className="adm-icon-btn" type="button" onClick={() => load(pagination.offset)} title="Actualizează">
          <RefreshCw className={loading ? 'adm-spin' : ''} size={19}/>
        </button>
      </header>
      <section className="adm-orders-panel">
        <div className="adm-toolbar adm-journal-toolbar">
          <div className="adm-search"><Search size={18}/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="SKU, produs, comandă, motiv" aria-label="Caută în jurnalul de stoc"/></div>
          <select value={type} onChange={(event) => setType(event.target.value)} aria-label="Tip mișcare">
            <option value="">Toate mișcările</option>
            {Object.entries(MOVEMENTS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
          <label className="adm-date-filter"><span>De la</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)}/></label>
          <label className="adm-date-filter"><span>Până la</span><input type="date" value={to} onChange={(event) => setTo(event.target.value)}/></label>
          {(type || query || from || to) && <button className="adm-clear" type="button" onClick={reset}>Resetează</button>}
        </div>
        {error && <div className="adm-list-message adm-error"><AlertTriangle size={18}/>{error}</div>}
        {!error && !loading && items.length === 0 && <div className="adm-list-message">Nu sunt mișcări pentru filtrele selectate</div>}
        <div className="adm-table-wrap">
          <table className="adm-table adm-journal-table">
            <thead><tr><th>Data</th><th>Tip</th><th>Produs</th><th>Fizic</th><th>Rezervat</th><th>Comandă</th><th>Detalii</th></tr></thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{dateTime(item.createdAt)}</td>
                  <td><b>{MOVEMENTS[item.type] || item.type}</b></td>
                  <td><b>{item.product.name}</b><span>{item.product.sku || item.product.key}</span></td>
                  <td><strong className={item.deltaOnHand > 0 ? 'adm-plus' : item.deltaOnHand < 0 ? 'adm-minus' : ''}>{signed(item.deltaOnHand)}</strong><span>sold {item.balanceOnHand}</span></td>
                  <td><strong className={item.deltaReserved > 0 ? 'adm-plus' : item.deltaReserved < 0 ? 'adm-minus' : ''}>{signed(item.deltaReserved)}</strong><span>sold {item.balanceReserved}</span></td>
                  <td>{item.order ? <><b>{item.order.no}</b><span>{item.order.id}</span></> : '—'}</td>
                  <td><b>{item.actor?.name || item.actor?.email || 'Sistem'}</b><span title={item.reason}>{item.reason || '—'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <div className="adm-table-loading"><LoaderCircle className="adm-spin" size={24}/></div>}
        </div>
        <footer className="adm-pagination">
          <span>{pagination.total} mișcări · pagina {currentPage} din {totalPages}</span>
          <div>
            <button className="adm-icon-btn" type="button" disabled={pagination.offset === 0 || loading} onClick={() => load(Math.max(0, pagination.offset - PAGE_SIZE))}><ArrowLeft size={18}/></button>
            <button className="adm-icon-btn" type="button" disabled={pagination.offset + PAGE_SIZE >= pagination.total || loading} onClick={() => load(pagination.offset + PAGE_SIZE)}><ArrowRight size={18}/></button>
          </div>
        </footer>
      </section>
    </>
  );
}
