import React from 'react';
import {
  AlertTriangle, ArrowLeft, ArrowRight, LoaderCircle, RefreshCw, Search,
} from 'lucide-react';
import { AdminApiError, adminRequest } from '../admin-api.js';

const PAGE_SIZE = 50;
const dateTime = (value) => value
  ? new Intl.DateTimeFormat('ro-MD', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : '—';
const jsonText = (value) => value === null ? '—' : JSON.stringify(value, null, 2);

export default function AdminAuditLog({ onUnauthorized }) {
  const [items, setItems] = React.useState([]);
  const [pagination, setPagination] = React.useState({ limit: PAGE_SIZE, offset: 0, total: 0 });
  const [search, setSearch] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [entityType, setEntityType] = React.useState('');
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
      if (query) params.set('q', query);
      if (entityType) params.set('entityType', entityType);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const payload = await adminRequest(`/api/admin/audit-log?${params}`);
      setItems(payload.items);
      setPagination(payload.pagination);
    } catch (requestError) {
      setError(requestError.message);
      if (requestError instanceof AdminApiError && requestError.status === 401) onUnauthorized?.();
    } finally {
      setLoading(false);
    }
  }, [entityType, from, onUnauthorized, query, to]);

  React.useEffect(() => { load(0); }, [load]);
  const reset = () => { setSearch(''); setEntityType(''); setFrom(''); setTo(''); };
  const currentPage = Math.floor(pagination.offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(pagination.total / PAGE_SIZE));

  return (
    <>
      <header className="adm-topbar">
        <div><span>Securitate</span><h1>Jurnal administrativ</h1></div>
        <button className="adm-icon-btn" type="button" onClick={() => load(pagination.offset)} title="Actualizează">
          <RefreshCw className={loading ? 'adm-spin' : ''} size={19}/>
        </button>
      </header>
      <section className="adm-orders-panel">
        <div className="adm-toolbar adm-journal-toolbar">
          <div className="adm-search"><Search size={18}/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Acțiune, obiect, administrator" aria-label="Caută în jurnalul de audit"/></div>
          <select value={entityType} onChange={(event) => setEntityType(event.target.value)} aria-label="Tip obiect">
            <option value="">Toate obiectele</option>
            <option value="order">Comenzi</option><option value="product">Produse</option>
            <option value="category">Categorii</option><option value="image">Imagini</option>
          </select>
          <label className="adm-date-filter"><span>De la</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)}/></label>
          <label className="adm-date-filter"><span>Până la</span><input type="date" value={to} onChange={(event) => setTo(event.target.value)}/></label>
          {(query || entityType || from || to) && <button className="adm-clear" type="button" onClick={reset}>Resetează</button>}
        </div>
        {error && <div className="adm-list-message adm-error"><AlertTriangle size={18}/>{error}</div>}
        {!error && !loading && items.length === 0 && <div className="adm-list-message">Nu sunt acțiuni pentru filtrele selectate</div>}
        <div className="adm-table-wrap">
          <table className="adm-table adm-audit-table">
            <thead><tr><th>Data</th><th>Administrator</th><th>Acțiune</th><th>Obiect</th><th>Modificări</th></tr></thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{dateTime(item.createdAt)}<span>{item.requestIp || 'IP indisponibil'}</span></td>
                  <td><b>{item.actor?.name || 'Sistem'}</b><span>{item.actor?.email || '—'}</span></td>
                  <td><code>{item.action}</code></td>
                  <td><b>{item.entityType}</b><span>{item.entityId}</span></td>
                  <td>
                    <details className="adm-audit-detail">
                      <summary>Vezi datele</summary>
                      <div><label>Înainte</label><pre>{jsonText(item.before)}</pre></div>
                      <div><label>După</label><pre>{jsonText(item.after)}</pre></div>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <div className="adm-table-loading"><LoaderCircle className="adm-spin" size={24}/></div>}
        </div>
        <footer className="adm-pagination">
          <span>{pagination.total} acțiuni · pagina {currentPage} din {totalPages}</span>
          <div>
            <button className="adm-icon-btn" type="button" disabled={pagination.offset === 0 || loading} onClick={() => load(Math.max(0, pagination.offset - PAGE_SIZE))}><ArrowLeft size={18}/></button>
            <button className="adm-icon-btn" type="button" disabled={pagination.offset + PAGE_SIZE >= pagination.total || loading} onClick={() => load(pagination.offset + PAGE_SIZE)}><ArrowRight size={18}/></button>
          </div>
        </footer>
      </section>
    </>
  );
}
