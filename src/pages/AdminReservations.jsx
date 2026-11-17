import React from 'react';
import {
  AlertTriangle, ArrowLeft, ArrowRight, LoaderCircle, RefreshCw, Search, ShoppingBag,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { AdminApiError, adminRequest } from '../admin-api.js';

const PAGE_SIZE = 50;
const ORDER_STATUS = {
  pending: 'Nouă', completed: 'Confirmată', cancelled: 'Anulată', returned: 'Retur',
};
const orderStatusLabel = (status) => (
  ['confirmed', 'processing', 'ready', 'shipped'].includes(status)
    ? ORDER_STATUS.completed
    : ORDER_STATUS[status] || status
);
const dateTime = (value) => value
  ? new Intl.DateTimeFormat('ro-MD', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : '—';

export default function AdminReservations({ onUnauthorized }) {
  const [items, setItems] = React.useState([]);
  const [summary, setSummary] = React.useState({ openOrders: 0, reservedUnits: 0 });
  const [pagination, setPagination] = React.useState({ limit: PAGE_SIZE, offset: 0, total: 0 });
  const [search, setSearch] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const load = React.useCallback(async (offset = 0, silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ state: 'ordered', limit: String(PAGE_SIZE), offset: String(offset) });
      if (query) params.set('q', query);
      const payload = await adminRequest(`/api/admin/reservations?${params}`);
      setItems(payload.items);
      setSummary(payload.summary);
      setPagination(payload.pagination);
    } catch (requestError) {
      setError(requestError.message);
      if (requestError instanceof AdminApiError && [401, 403].includes(requestError.status)) onUnauthorized?.();
    } finally {
      if (!silent) setLoading(false);
    }
  }, [onUnauthorized, query]);

  React.useEffect(() => { load(0); }, [load]);
  React.useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load(pagination.offset, true);
    }, 5000);
    return () => clearInterval(timer);
  }, [load, pagination.offset]);

  const currentPage = Math.floor(pagination.offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(pagination.total / PAGE_SIZE));

  return (
    <>
      <header className="adm-topbar">
        <div><span>Actualizare automată la 5 secunde</span><h1>Rezervări din comenzi</h1></div>
        <button className="adm-icon-btn" type="button" onClick={() => load(pagination.offset)} title="Actualizează">
          <RefreshCw className={loading ? 'adm-spin' : ''} size={19}/>
        </button>
      </header>
      <section className="adm-summary adm-reservation-summary" aria-label="Sumar rezervări">
        <div className="adm-summary-metric"><span>Comenzi deschise</span><b>{summary.openOrders}</b><small>{summary.reservedUnits} unități rezervate</small></div>
      </section>
      <section className="adm-orders-panel">
        <div className="adm-toolbar adm-reservations-toolbar">
          <div className="adm-search"><Search size={18}/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Produs, SKU, număr comandă, client" aria-label="Caută rezervări și comenzi"/></div>
          {query && <button className="adm-clear" type="button" onClick={() => setSearch('')}>Resetează</button>}
        </div>
        {error && <div className="adm-list-message adm-error" role="alert"><AlertTriangle size={18}/>{error}</div>}
        {!error && !loading && items.length === 0 && <div className="adm-list-message"><ShoppingBag size={24}/>Nu sunt comenzi cu produse rezervate</div>}
        <div className="adm-table-wrap">
          <table className="adm-table adm-reservations-table">
            <thead><tr><th>Stare</th><th>Produs</th><th>Cantitate</th><th>Stoc</th><th>Comandă</th><th>Actualizat</th></tr></thead>
            <tbody>{items.map((item) => (
              <tr key={item.id}>
                <td><span className="adm-reservation-state ordered"><ShoppingBag size={14}/>Comandă</span></td>
                <td><b>{item.product.name}</b><span>{item.product.sku || item.product.key}</span></td>
                <td><strong>{item.quantity}</strong></td>
                <td><b>Disponibil {item.inventory.available}</b><span>Fizic {item.inventory.onHand} · rezervat {item.inventory.reserved}</span></td>
                <td>{item.order
                  ? <Link className="adm-order-link" to={`/admin/orders?open=${encodeURIComponent(item.order.id)}`}><b>{item.order.no}</b><span>{orderStatusLabel(item.order.status)} · {item.order.customerName}</span></Link>
                  : null}</td>
                <td>{dateTime(item.order?.updatedAt || item.order?.createdAt || item.updatedAt)}</td>
              </tr>
            ))}</tbody>
          </table>
          {loading && <div className="adm-table-loading"><LoaderCircle className="adm-spin" size={24}/></div>}
        </div>
        <footer className="adm-pagination">
          <span>{pagination.total} poziții · pagina {currentPage} din {totalPages}</span>
          <div>
            <button className="adm-icon-btn" type="button" disabled={pagination.offset === 0 || loading} onClick={() => load(Math.max(0, pagination.offset - PAGE_SIZE))}><ArrowLeft size={18}/></button>
            <button className="adm-icon-btn" type="button" disabled={pagination.offset + PAGE_SIZE >= pagination.total || loading} onClick={() => load(pagination.offset + PAGE_SIZE)}><ArrowRight size={18}/></button>
          </div>
        </footer>
      </section>
    </>
  );
}
