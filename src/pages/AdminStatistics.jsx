import React from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Banknote,
  CheckCircle2,
  Download,
  Eye,
  LoaderCircle,
  RefreshCw,
  Search,
  ShoppingCart,
  Warehouse,
} from 'lucide-react';
import { AdminApiError, adminDownload, adminRequest } from '../admin-api.js';
import { handleTabListKeyDown } from '../dialog-a11y.js';

const PAGE_SIZE = 50;
const STAT_TABS = ['products', 'categories', 'brands', 'daily'];
const moneyFormatter = new Intl.NumberFormat('ro-MD', { maximumFractionDigits: 2 });
const numberFormatter = new Intl.NumberFormat('ro-MD');
const money = (value) => value == null ? '—' : `${moneyFormatter.format(Number(value || 0))} lei`;
const quantity = (value) => numberFormatter.format(Number(value || 0));

const utcRange = (days, now = new Date()) => ({
  from: new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString(),
  to: now.toISOString(),
});
const dateInput = (date = new Date()) => date.toISOString().slice(0, 10);
const daysAgoInput = (days) => dateInput(new Date(Date.now() - days * 24 * 60 * 60 * 1000));

function reportParams(range, options = {}) {
  const params = new URLSearchParams({
    from: range.from,
    to: range.to,
    limit: String(options.limit ?? PAGE_SIZE),
    offset: String(options.offset || 0),
  });
  if (options.q) params.set('q', options.q);
  if (options.category) params.set('category', options.category);
  if (options.brand) params.set('brand', options.brand);
  if (options.stock) params.set('stock', options.stock);
  return params;
}

function MetricCard({ label, value, note, tone = '' }) {
  return <article className={`adm-stat-card ${tone}`}><span>{label}</span><b>{value}</b>{note && <small>{note}</small>}</article>;
}

function Profit({ row }) {
  return row.grossProfit == null
    ? <span title={`${row.unknownCostUnits || 0} unități fără cost de achiziție`}>—</span>
    : <strong>{money(row.grossProfit)}</strong>;
}

function ProductsTable({ items }) {
  return (
    <div className="adm-table-wrap adm-stat-table-wrap">
      <table className="adm-table adm-stat-products-table">
        <thead><tr><th>Produs</th><th>Categorie / brand</th><th>Vândut</th><th>Returnat</th><th>Net buc.</th><th>Venit net</th><th>COGS</th><th>Profit brut</th><th>Stoc</th></tr></thead>
        <tbody>{items.map((row) => <tr key={row.id}>
          <td><b>{row.name}</b><span>{row.sku || row.key}</span></td>
          <td><b>{row.categoryName}</b><span>{row.brand}</span></td>
          <td>{quantity(row.soldUnits)}</td><td>{quantity(row.returnedUnits)}</td>
          <td><strong>{quantity(row.netUnits)}</strong></td>
          <td><strong>{money(row.netRevenue)}</strong></td><td>{row.unknownCostUnits ? '—' : money(row.cogs)}</td>
          <td><Profit row={row}/></td>
          <td><b>{quantity(row.available)}</b><span>{row.onHand} fizic · {row.reserved} rezervat</span></td>
        </tr>)}</tbody>
      </table>
    </div>
  );
}

function DimensionTable({ items, kind }) {
  return (
    <div className="adm-table-wrap adm-stat-table-wrap">
      <table className="adm-table adm-stat-dimension-table">
        <thead><tr><th>{kind === 'categories' ? 'Categorie' : 'Brand'}</th><th>Vândut</th><th>Returnat</th><th>Net buc.</th><th>Venit net</th><th>COGS</th><th>Profit brut</th><th>Valoare stoc</th></tr></thead>
        <tbody>{items.map((row) => <tr key={row.id}>
          <td><b>{row.name}</b><span>{row.id}</span></td>
          <td>{quantity(row.soldUnits)}</td><td>{quantity(row.returnedUnits)}</td>
          <td><strong>{quantity(row.netUnits)}</strong></td>
          <td><strong>{money(row.netRevenue)}</strong></td><td>{row.unknownCostUnits ? '—' : money(row.cogs)}</td>
          <td><Profit row={row}/></td>
          <td>{money(row.currentInventoryCost)}<span>{row.inventoryUnknownCostUnits ? `${row.inventoryUnknownCostUnits} buc. fără cost` : 'cost complet'}</span></td>
        </tr>)}</tbody>
      </table>
    </div>
  );
}

export default function AdminStatistics({ onUnauthorized }) {
  const [preset, setPreset] = React.useState(30);
  const [range, setRange] = React.useState(() => utcRange(30));
  const [customFrom, setCustomFrom] = React.useState(() => daysAgoInput(29));
  const [customTo, setCustomTo] = React.useState(() => dateInput());
  const [customError, setCustomError] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [category, setCategory] = React.useState('');
  const [brand, setBrand] = React.useState('');
  const [stock, setStock] = React.useState('');
  const [offset, setOffset] = React.useState(0);
  const [tab, setTab] = React.useState('products');
  const [report, setReport] = React.useState(null);
  const [events, setEvents] = React.useState(null);
  const [eventsError, setEventsError] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [downloading, setDownloading] = React.useState('');

  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  React.useEffect(() => { setOffset(0); }, [query, category, brand, stock, range.from, range.to]);

  const filters = React.useMemo(() => ({ query, category, brand, stock, offset }), [brand, category, offset, query, stock]);
  const load = React.useCallback(async () => {
    setLoading(true);
    setError('');
    setEventsError('');
    const params = reportParams(range, { q: query, category, brand, stock, offset });
    try {
      const payload = await adminRequest(`/api/admin/statistics?${params}`);
      setReport(payload);
    } catch (requestError) {
      setError(requestError.message);
      if (requestError instanceof AdminApiError && [401, 403].includes(requestError.status)) onUnauthorized?.();
      setLoading(false);
      return;
    }
    try {
      const payload = await adminRequest(`/api/admin/statistics/events?${reportParams(range)}`);
      setEvents(payload);
    } catch (requestError) {
      setEvents(null);
      setEventsError(requestError.message);
      if (requestError instanceof AdminApiError && [401, 403].includes(requestError.status)) onUnauthorized?.();
    } finally {
      setLoading(false);
    }
  }, [brand, category, offset, onUnauthorized, query, range, stock]);
  React.useEffect(() => { load(); }, [load]);

  const selectPreset = (days) => {
    setPreset(days);
    setCustomError('');
    setRange(utcRange(days));
  };
  const applyCustom = () => {
    const from = new Date(`${customFrom}T00:00:00.000Z`);
    const inclusiveTo = new Date(`${customTo}T00:00:00.000Z`);
    if (Number.isNaN(from.valueOf()) || Number.isNaN(inclusiveTo.valueOf()) || inclusiveTo < from) {
      setCustomError('Intervalul personalizat este invalid');
      return;
    }
    inclusiveTo.setUTCDate(inclusiveTo.getUTCDate() + 1);
    setPreset('custom');
    setCustomError('');
    setRange({ from: from.toISOString(), to: inclusiveTo.toISOString() });
  };
  const download = async (name) => {
    if (downloading) return;
    setDownloading(name);
    setError('');
    try {
      const params = reportParams(range, { q: query, category, brand, stock, offset: 0, limit: 250 });
      params.set('report', name);
      await adminDownload(`/api/admin/statistics/export?${params}`, `nailmania-${name}.csv`);
    } catch (requestError) {
      setError(requestError.message);
      if (requestError instanceof AdminApiError && [401, 403].includes(requestError.status)) onUnauthorized?.();
    } finally {
      setDownloading('');
    }
  };

  const summary = report?.summary;
  const orderFlow = summary?.orderFlow || {
    received: 0,
    receivedValue: 0,
    active: 0,
    pending: 0,
    confirmed: 0,
    processing: 0,
    ready: 0,
    shipped: 0,
    cancelled: 0,
    cancelledValue: 0,
  };
  const eventMetrics = events?.configured ? events.metrics : null;
  const eventSource = events?.source === 'd1'
    ? 'D1 · agregare zilnică exactă'
    : 'Analytics Engine · ponderat după sampling';
  const pagination = report?.productPagination || { total: 0, limit: PAGE_SIZE, offset: 0 };
  const page = Math.floor(pagination.offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(pagination.total / PAGE_SIZE));
  const rangeLabel = `${range.from.slice(0, 10)} — ${new Date(new Date(range.to).getTime() - 1).toISOString().slice(0, 10)} · UTC`;

  return (
    <div className="adm-statistics">
      <header className="adm-topbar adm-stat-topbar">
        <div><span>Rapoarte</span><h1>Statistică</h1><small>{rangeLabel}</small></div>
        <button className="adm-icon-btn" type="button" onClick={load} title="Actualizează" disabled={loading}><RefreshCw className={loading ? 'adm-spin' : ''} size={19}/></button>
      </header>

      <section className="adm-stat-period" aria-label="Perioadă statistică">
        <div className="adm-stat-presets">{[7, 30, 90].map((days) => <button key={days} type="button" aria-pressed={preset === days} className={preset === days ? 'active' : ''} onClick={() => selectPreset(days)}>{days} zile</button>)}</div>
        <div className="adm-stat-custom">
          <label><span>De la (UTC)</span><input type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)}/></label>
          <label><span>Până la inclusiv (UTC)</span><input type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)}/></label>
          <button type="button" className={preset === 'custom' ? 'adm-primary' : 'adm-compact-btn'} onClick={applyCustom}>Aplică</button>
        </div>
        {customError && <span className="adm-inline-error" role="alert"><AlertTriangle size={14}/>{customError}</span>}
      </section>

      {error && <div className="adm-list-message adm-error" role="alert"><AlertTriangle size={18}/>{error}</div>}
      {!report && loading && <div className="adm-list-message" role="status"><LoaderCircle className="adm-spin" size={24}/>Se calculează rapoartele…</div>}

      {summary && <>
        <section className="adm-stat-cards" aria-label="Indicatori de vânzare">
          <MetricCard label="Comenzi primite" value={quantity(orderFlow.received)} note={`${money(orderFlow.receivedValue)} valoare comandată`} tone="primary"/>
          <MetricCard label="Comenzi active" value={quantity(orderFlow.active)} note={`${orderFlow.pending} în așteptare · ${orderFlow.confirmed} confirmate · ${orderFlow.processing + orderFlow.ready + orderFlow.shipped} în proces`}/>
          <MetricCard label="Vânzări finalizate" value={quantity(summary.orders)} note={`${summary.returnedOrders} cu retur complet`}/>
          <MetricCard label="Comenzi anulate" value={quantity(orderFlow.cancelled)} note={money(orderFlow.cancelledValue)} tone="negative"/>
          <MetricCard label="Venit net" value={money(summary.netRevenue)} note="vânzări minus rambursări" tone="primary"/>
          <MetricCard label="Vânzări încasate" value={money(summary.saleRevenue)} note={`${money(summary.deliveryRevenue)} livrare`}/>
          <MetricCard label="Rambursări" value={money(summary.refundAmount)} note={`${summary.returnCount} operațiuni · ${summary.returnedUnits} buc.`} tone="negative"/>
          <MetricCard label="Reduceri catalog" value={money(summary.catalogDiscount)} note={`promo ${money(summary.promoDiscount)}`}/>
          <MetricCard label="Bon mediu net" value={money(summary.averageCheck)} note="net / comenzi finalizate"/>
          <MetricCard label="Profit brut" value={money(summary.grossProfit)} note={summary.grossProfit == null ? `${summary.unknownCostUnits} buc. fără cost` : `COGS ${money(summary.cogs)}`}/>
          <MetricCard label="Valoare stoc calculată" value={summary.inventory.knownCostUnits ? money(summary.inventory.currentCost) : '—'} note={`${summary.inventory.costCoveragePercent}% acoperire cost · ${summary.inventory.unknownCostUnits} buc. fără cost`}/>
        </section>

        <section className="adm-stat-event-panel">
          <header><div><BarChart3 size={19}/><div><b>Evenimente magazin</b><span>{eventSource}</span></div></div></header>
          {eventMetrics ? <div className="adm-stat-event-grid">
            <div><Eye size={17}/><span>Vizualizări</span><b>{quantity(eventMetrics.views)}</b></div>
            <div><ShoppingCart size={17}/><span>Adăugări</span><b>{quantity(eventMetrics.addToCart)}</b></div>
            <div><Search size={17}/><span>Căutări</span><b>{quantity(eventMetrics.searches)}</b></div>
            <div><Warehouse size={17}/><span>Checkout</span><b>{quantity(eventMetrics.checkoutStarted)}</b></div>
            <div><CheckCircle2 size={17}/><span>Comenzi online</span><b>{quantity(eventMetrics.ordersCreated)}</b></div>
            <div><Banknote size={17}/><span>Valoare comenzi</span><b>{money(eventMetrics.orderValue)}</b></div>
            <div><span>Checkout → comandă</span><b>{eventMetrics.checkoutConversionRate}%</b></div>
            <div><span>Vizualizare → comandă</span><b>{eventMetrics.orderConversionRate}%</b></div>
          </div> : <div className="adm-stat-events-empty">{eventsError || 'Evenimentele magazinului nu sunt încă disponibile.'}</div>}
        </section>

        <section className="adm-orders-panel adm-stat-report-panel">
          <div className="adm-stat-report-head">
            <div className="adm-stat-tabs" role="tablist" aria-label="Raport statistic" onKeyDown={(event) => handleTabListKeyDown(event, STAT_TABS, tab, setTab)}>
              <button type="button" role="tab" aria-selected={tab === 'products'} tabIndex={tab === 'products' ? 0 : -1} className={tab === 'products' ? 'active' : ''} onClick={() => setTab('products')}>Produse</button>
              <button type="button" role="tab" aria-selected={tab === 'categories'} tabIndex={tab === 'categories' ? 0 : -1} className={tab === 'categories' ? 'active' : ''} onClick={() => setTab('categories')}>Categorii</button>
              <button type="button" role="tab" aria-selected={tab === 'brands'} tabIndex={tab === 'brands' ? 0 : -1} className={tab === 'brands' ? 'active' : ''} onClick={() => setTab('brands')}>Branduri</button>
              <button type="button" role="tab" aria-selected={tab === 'daily'} tabIndex={tab === 'daily' ? 0 : -1} className={tab === 'daily' ? 'active' : ''} onClick={() => setTab('daily')}>Pe zile</button>
            </div>
            <div className="adm-stat-exports">
              {[
                ['sales', 'Vânzări'], ['products', 'Produse'], ['inventory', 'Stoc'], ['movements', 'Mișcări'],
              ].map(([key, label]) => <button className="adm-compact-btn" type="button" key={key} onClick={() => download(key)} disabled={Boolean(downloading)}><Download size={14}/>{downloading === key ? '…' : label}</button>)}
            </div>
          </div>

          {tab === 'products' && <div className="adm-toolbar adm-stat-filters">
            <div className="adm-search"><Search size={18}/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Produs, SKU sau brand" aria-label="Caută în raport"/></div>
            <select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Filtru categorie"><option value="">Toate categoriile</option>{report.categories.map((row) => <option value={row.id} key={row.id}>{row.name}</option>)}</select>
            <select value={brand} onChange={(event) => setBrand(event.target.value)} aria-label="Filtru brand"><option value="">Toate brandurile</option>{report.brands.map((row) => <option value={row.id} key={row.id}>{row.name}</option>)}</select>
            <select value={stock} onChange={(event) => setStock(event.target.value)} aria-label="Filtru stoc"><option value="">Orice stoc</option><option value="no_sales">Fără vânzări</option><option value="low">Stoc redus</option><option value="out">Stoc epuizat</option></select>
            {(filters.query || filters.category || filters.brand || filters.stock) && <button className="adm-clear" type="button" onClick={() => { setSearch(''); setCategory(''); setBrand(''); setStock(''); }}>Resetează</button>}
          </div>}

          {loading && <div className="adm-stat-loading" role="status"><LoaderCircle className="adm-spin" size={22}/>Actualizare…</div>}
          {tab === 'products' && (report.products.length ? <ProductsTable items={report.products}/> : <div className="adm-list-message">Nu sunt produse pentru filtrele alese</div>)}
          {tab === 'categories' && <DimensionTable items={report.categories} kind="categories"/>}
          {tab === 'brands' && <DimensionTable items={report.brands} kind="brands"/>}
          {tab === 'daily' && <div className="adm-table-wrap adm-stat-table-wrap"><table className="adm-table adm-stat-daily-table"><thead><tr><th>Zi UTC</th><th>Primite</th><th>Valoare comenzi</th><th>Finalizate</th><th>Vânzări</th><th>Rambursări</th><th>Venit net</th></tr></thead><tbody>{report.daily.map((row) => <tr key={row.day}><td><b>{row.day}</b></td><td>{row.receivedOrders}</td><td>{money(row.receivedValue)}</td><td>{row.orders}</td><td>{money(row.saleRevenue)}</td><td>{money(row.refundAmount)}</td><td><strong>{money(row.netRevenue)}</strong></td></tr>)}</tbody></table></div>}

          {tab === 'products' && <footer className="adm-pagination">
            <span>{pagination.total} produse · pagina {page} din {pages}</span>
            <div><button className="adm-icon-btn" type="button" aria-label="Pagina precedentă" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}><ArrowLeft size={18}/></button><button className="adm-icon-btn" type="button" aria-label="Pagina următoare" disabled={offset + PAGE_SIZE >= pagination.total || loading} onClick={() => setOffset(offset + PAGE_SIZE)}><ArrowRight size={18}/></button></div>
          </footer>}
        </section>
      </>}
    </div>
  );
}
