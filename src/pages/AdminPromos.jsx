import React from 'react';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  TicketPercent,
  Trash2,
  X,
} from 'lucide-react';
import { AdminApiError, adminRequest } from '../admin-api.js';
import AdminProductScopePicker from '../components/AdminProductScopePicker.jsx';
import { useDialogFocus } from '../dialog-a11y.js';

const money = (value) => `${new Intl.NumberFormat('ro-MD').format(Number(value || 0))} lei`;
const dateTime = (value) => value
  ? new Intl.DateTimeFormat('ro-MD', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : '—';
const localDateTime = (value) => {
  if (!value) return '';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '';
  return new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const isoDateTime = (value) => value ? new Date(value).toISOString() : null;
const nullableInteger = (value) => value === '' ? null : Number(value);
const foldBrand = (value) => String(value || '').trim().toLocaleLowerCase('ro');

const promoCategoryOptions = (available, selected, selectedIds) => {
  const options = [...available];
  const known = new Set(available.map((category) => category.id));
  for (const id of selectedIds) {
    if (known.has(id)) continue;
    const category = selected.find((item) => item.id === id);
    options.push({
      id,
      nameRo: category?.nameRo || category?.name_ro || id,
      productCount: null,
      unavailable: true,
    });
  }
  return options;
};

const promoBrandOptions = (available, selectedNames) => {
  const options = [...available];
  const known = new Set(available.map((brand) => foldBrand(brand.name)));
  for (const name of selectedNames) {
    if (known.has(foldBrand(name))) continue;
    options.push({ name, productCount: null, unavailable: true });
  }
  return options;
};

const emptyPromo = () => ({
  code: '',
  discountType: 'percent',
  discountValue: 10,
  maxDiscount: null,
  minOrderAmount: 0,
  startsAt: null,
  endsAt: null,
  totalUseLimit: null,
  perUserLimit: null,
  isActive: true,
  revision: '',
  categories: [],
  brands: [],
  products: [],
  orders: [],
});

const promoForm = (promo) => ({
  code: promo?.code || '',
  discountType: promo?.discountType || 'percent',
  discountValue: String(promo?.discountValue ?? 10),
  maxDiscount: promo?.maxDiscount == null ? '' : String(promo.maxDiscount),
  minOrderAmount: String(promo?.minOrderAmount ?? 0),
  startsAt: localDateTime(promo?.startsAt),
  endsAt: localDateTime(promo?.endsAt),
  totalUseLimit: promo?.totalUseLimit == null ? '' : String(promo.totalUseLimit),
  perUserLimit: promo?.perUserLimit == null ? '' : String(promo.perUserLimit),
  isActive: promo?.isActive ?? true,
});

function PromoState({ promo }) {
  const now = Date.now();
  let label = 'Activ';
  let tone = 'active';
  if (!promo.isActive) { label = 'Inactiv'; tone = 'inactive'; }
  else if (promo.startsAt && Date.parse(promo.startsAt) > now) { label = 'Programat'; tone = 'scheduled'; }
  else if (promo.endsAt && Date.parse(promo.endsAt) <= now) { label = 'Expirat'; tone = 'expired'; }
  else if (promo.totalUseLimit != null && promo.usageCount >= promo.totalUseLimit) { label = 'Epuizat'; tone = 'expired'; }
  return <span className={`adm-product-state ${tone}`}>{label}</span>;
}

function PromoEditor({
  promo,
  creating,
  categories,
  brands,
  scopesReady,
  scopesLoading,
  scopeError,
  onRetryScopes,
  loading,
  error,
  onClose,
  onSave,
  onDeactivate,
  onUnauthorized,
}) {
  const [form, setForm] = React.useState(() => promoForm(promo || emptyPromo()));
  const [categoryIds, setCategoryIds] = React.useState(() => (promo?.categories || []).map((item) => item.id));
  const [brandNames, setBrandNames] = React.useState(() => promo?.brands || []);
  const [products, setProducts] = React.useState(() => promo?.products || []);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState('');
  const dialogRef = useDialogFocus(() => { if (!saving) onClose(); });

  React.useEffect(() => {
    if (!promo) return;
    setForm(promoForm(promo));
    setCategoryIds((promo.categories || []).map((item) => item.id));
    setBrandNames(promo.brands || []);
    setProducts(promo.products || []);
  }, [promo]);
  const set = (key) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm((current) => ({ ...current, [key]: value }));
  };
  const toggleCategory = (id) => setCategoryIds((current) => current.includes(id)
    ? current.filter((item) => item !== id)
    : [...current, id]);
  const toggleBrand = (name) => setBrandNames((current) => current.some((item) => foldBrand(item) === foldBrand(name))
    ? current.filter((item) => foldBrand(item) !== foldBrand(name))
    : [...current, name]);
  const submit = async (event) => {
    event.preventDefault();
    if (!promo || saving) return;
    if (!scopesReady) {
      setSaveError('Încarcă selecțiile catalogului înainte de salvare.');
      return;
    }
    setSaving(true); setSaveError('');
    try {
      const body = {
        code: form.code.trim().toUpperCase(),
        discountType: form.discountType,
        discountValue: Number(form.discountValue),
        maxDiscount: form.discountType === 'percent' ? nullableInteger(form.maxDiscount) : null,
        minOrderAmount: Number(form.minOrderAmount || 0),
        startsAt: isoDateTime(form.startsAt),
        endsAt: isoDateTime(form.endsAt),
        totalUseLimit: nullableInteger(form.totalUseLimit),
        perUserLimit: nullableInteger(form.perUserLimit),
        isActive: Boolean(form.isActive),
        categoryIds,
        brands: brandNames,
        productIds: products.map((item) => Number(item.id)),
        ...(!creating ? { revision: promo.revision } : {}),
      };
      await onSave(promo.id, body, creating);
    } catch (caught) { setSaveError(caught.message); }
    finally { setSaving(false); }
  };
  const deactivate = async () => {
    if (!promo || creating || saving || !promo.isActive) return;
    setSaving(true); setSaveError('');
    try { await onDeactivate(promo.id, promo.revision); }
    catch (caught) { setSaveError(caught.message); }
    finally { setSaving(false); }
  };

  const categoryOptions = promoCategoryOptions(categories, promo?.categories || [], categoryIds);
  const brandOptions = promoBrandOptions(brands, brandNames);

  return (
    <div className="adm-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <aside className="adm-drawer adm-promo-drawer" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Editor cod promo" tabIndex={-1}>
        <header className="adm-drawer-head"><div><span>Cod promo</span><h2>{creating ? 'Cod nou' : promo?.code || 'Se încarcă'}</h2></div><button className="adm-icon-btn" type="button" onClick={onClose} disabled={saving} aria-label="Închide" data-dialog-initial-focus><X size={20}/></button></header>
        {loading && <div className="adm-table-loading" role="status" aria-label="Se încarcă promoția"><LoaderCircle className="adm-spin" size={24}/></div>}
        {error && <div className="adm-list-message adm-error" role="alert"><AlertTriangle size={18}/>{error}</div>}
        {promo && !loading && <form onSubmit={submit} className="adm-promo-form">
          {!scopesReady && <div className={`adm-scope-alert${scopeError ? ' adm-error' : ''}`} role={scopeError ? 'alert' : 'status'}>
            {scopesLoading ? <LoaderCircle className="adm-spin" size={16}/> : <AlertTriangle size={16}/>}<span>{scopeError || 'Se încarcă selecțiile catalogului…'}</span>
            {scopeError && <button className="adm-compact-btn" type="button" onClick={onRetryScopes} disabled={scopesLoading}>Reîncearcă</button>}
          </div>}
          <div className="adm-form-section">
            <h3>Condițiile reducerii</h3>
            <div className="adm-form-grid adm-promo-grid">
              <label className="full"><span>Cod</span><input value={form.code} onChange={set('code')} maxLength={32} pattern="[A-Za-z0-9_-]{3,32}" required/></label>
              <label><span>Tip</span><select value={form.discountType} onChange={set('discountType')}><option value="percent">Procent</option><option value="fixed">Sumă fixă</option></select></label>
              <label><span>{form.discountType === 'percent' ? 'Procent (%)' : 'Reducere (lei)'}</span><input type="number" min="1" max={form.discountType === 'percent' ? 100 : 10000000} step="1" value={form.discountValue} onChange={set('discountValue')} required/></label>
              {form.discountType === 'percent' && <label><span>Reducere maximă (lei)</span><input type="number" min="1" step="1" value={form.maxDiscount} onChange={set('maxDiscount')} placeholder="Fără limită"/></label>}
              <label><span>Comandă minimă (lei)</span><input type="number" min="0" step="1" value={form.minOrderAmount} onChange={set('minOrderAmount')} required/></label>
              <label><span>Începe la</span><input type="datetime-local" value={form.startsAt} onChange={set('startsAt')}/></label>
              <label><span>Expiră la</span><input type="datetime-local" value={form.endsAt} onChange={set('endsAt')}/></label>
              <label><span>Limită totală</span><input type="number" min="1" step="1" value={form.totalUseLimit} onChange={set('totalUseLimit')} placeholder="Nelimitat"/></label>
              <label><span>Limită per client</span><input type="number" min="1" step="1" value={form.perUserLimit} onChange={set('perUserLimit')} placeholder="Nelimitat"/><small>O limită per client cere autentificare; fără ea, codul poate fi folosit de oaspeți.</small></label>
              <label className="adm-check adm-promo-active"><input type="checkbox" checked={form.isActive} onChange={set('isActive')}/><span>Cod activ</span></label>
            </div>
          </div>
          <div className="adm-form-section">
            <h3>Categorii eligibile</h3>
            <p className="adm-form-hint">Fără categorii, branduri și produse selectate, codul se aplică întregului coș. Selecțiile se reunesc.</p>
            <div className="adm-promo-category-grid adm-scope-grid">{categoryOptions.map((category) => <label className="adm-check" key={category.id}><input type="checkbox" disabled={saving || !scopesReady} checked={categoryIds.includes(category.id)} onChange={() => toggleCategory(category.id)}/><span>{category.nameRo || category.name_ro || category.id}<small>{category.unavailable ? 'indisponibilă' : `${category.productCount} produse`}</small></span></label>)}</div>
          </div>
          <div className="adm-form-section">
            <h3>Branduri eligibile</h3>
            <div className="adm-promo-category-grid adm-scope-grid">{brandOptions.map((brand) => <label className="adm-check" key={brand.name}><input type="checkbox" disabled={saving || !scopesReady} checked={brandNames.some((name) => foldBrand(name) === foldBrand(brand.name))} onChange={() => toggleBrand(brand.name)}/><span>{brand.name}<small>{brand.unavailable ? 'indisponibil' : `${brand.productCount} produse`}</small></span></label>)}</div>
          </div>
          <div className="adm-form-section"><h3>Produse eligibile</h3><AdminProductScopePicker selected={products} onChange={setProducts} label="promoție" onUnauthorized={onUnauthorized} disabled={saving || !scopesReady}/></div>
          {!creating && <div className="adm-form-section">
            <div className="adm-section-head"><h3>Utilizare și comenzi</h3><span className="adm-promo-metric">{promo.usageCount} utilizări · {money(promo.discountSum)}</span></div>
            {!promo.orders?.length && <div className="adm-muted-empty">Codul nu a fost folosit</div>}
            {promo.orders?.length > 0 && <div className="adm-promo-orders">
              {promo.orders.map((order) => <article key={order.id}><div><b>{order.no}</b><span>{order.customerName} · {dateTime(order.createdAt)}</span></div><div><strong>−{money(order.discountAmount)}</strong><span>{order.status}{order.releasedAt ? ` · eliberat (${order.releaseReason})` : ''}</span>{order.promoRefundAmount > 0 && <small>Reversat la retur: {money(order.promoRefundAmount)}</small>}</div></article>)}
            </div>}
          </div>}
          {saveError && <div className="adm-list-message adm-error" role="alert"><AlertTriangle size={18}/>{saveError}</div>}
          <footer className="adm-promo-actions">
            {!creating && promo.isActive && <button className="adm-compact-btn danger" type="button" onClick={deactivate} disabled={saving}><Trash2 size={15}/>Dezactivează</button>}
            <button className="adm-primary" type="submit" disabled={saving || !scopesReady}>{saving ? <LoaderCircle className="adm-spin" size={17}/> : <Check size={17}/>}Salvează</button>
          </footer>
        </form>}
      </aside>
    </div>
  );
}

export default function AdminPromos({ onUnauthorized }) {
  const [items, setItems] = React.useState([]);
  const [counts, setCounts] = React.useState({});
  const [categories, setCategories] = React.useState([]);
  const [brands, setBrands] = React.useState([]);
  const [scopesReady, setScopesReady] = React.useState(false);
  const [scopesLoading, setScopesLoading] = React.useState(true);
  const [scopeError, setScopeError] = React.useState('');
  const [state, setState] = React.useState('all');
  const [search, setSearch] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [selectedId, setSelectedId] = React.useState('');
  const [detail, setDetail] = React.useState(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailError, setDetailError] = React.useState('');
  const [creating, setCreating] = React.useState(false);

  const rethrowAuth = React.useCallback((caught) => {
    if (caught instanceof AdminApiError && [401, 403].includes(caught.status)) onUnauthorized?.();
    throw caught;
  }, [onUnauthorized]);
  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const loadScopes = React.useCallback(async () => {
    setScopesLoading(true);
    setScopesReady(false);
    setScopeError('');
    try {
      const payload = await adminRequest('/api/admin/catalog-scopes');
      setCategories(payload.categories);
      setBrands(payload.brands);
      setScopesReady(true);
    } catch (caught) {
      setScopeError(caught.message);
      if (caught instanceof AdminApiError && [401, 403].includes(caught.status)) onUnauthorized?.();
    } finally {
      setScopesLoading(false);
    }
  }, [onUnauthorized]);
  React.useEffect(() => { loadScopes(); }, [loadScopes]);
  const load = React.useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ state });
      if (query) params.set('q', query);
      const payload = await adminRequest(`/api/admin/promos?${params}`);
      setItems(payload.items); setCounts(payload.counts);
    } catch (caught) {
      setError(caught.message);
      if (caught instanceof AdminApiError && [401, 403].includes(caught.status)) onUnauthorized?.();
    } finally { setLoading(false); }
  }, [onUnauthorized, query, state]);
  React.useEffect(() => { load(); }, [load]);

  const open = async (id) => {
    setSelectedId(id); setCreating(false); setDetail(null); setDetailError(''); setDetailLoading(true);
    try { setDetail((await adminRequest(`/api/admin/promos/${encodeURIComponent(id)}`)).promo); }
    catch (caught) { setDetailError(caught.message); if (caught instanceof AdminApiError && [401, 403].includes(caught.status)) onUnauthorized?.(); }
    finally { setDetailLoading(false); }
  };
  const create = () => {
    if (!scopesReady) return;
    setCreating(true); setSelectedId('new'); setDetail(emptyPromo()); setDetailError('');
  };
  const close = () => { setSelectedId(''); setDetail(null); setCreating(false); setDetailError(''); };
  const save = async (id, body, isNew) => {
    try {
      const payload = await adminRequest(isNew ? '/api/admin/promos' : `/api/admin/promos/${encodeURIComponent(id)}`, { method: isNew ? 'POST' : 'PATCH', body });
      setDetail(payload.promo); setSelectedId(payload.promo.id); setCreating(false); await load();
    } catch (caught) { return rethrowAuth(caught); }
  };
  const deactivate = async (id, revision) => {
    try {
      const payload = await adminRequest(`/api/admin/promos/${encodeURIComponent(id)}`, { method: 'DELETE', body: { revision } });
      setDetail(payload.promo); await load();
    } catch (caught) { return rethrowAuth(caught); }
  };
  return (
    <>
      <header className="adm-topbar adm-promos-topbar"><div><span>Vânzări</span><h1>Coduri promo</h1></div><div><button className="adm-icon-btn" type="button" onClick={() => { load(); loadScopes(); }} title="Actualizează" aria-label="Actualizează codurile promo și selecțiile catalogului"><RefreshCw className={loading || scopesLoading ? 'adm-spin' : ''} size={19}/></button><button className="adm-primary" type="button" onClick={create} disabled={!scopesReady} title={!scopesReady ? 'Selecțiile catalogului nu sunt încă disponibile' : ''}><Plus size={18}/>Cod nou</button></div></header>
      <section className="adm-summary adm-promo-summary" aria-label="Sumar coduri promo">
        <button type="button" aria-pressed={state === 'all'} className={state === 'all' ? 'active' : ''} onClick={() => setState('all')}><span>Total</span><b>{counts.total || 0}</b></button>
        <button type="button" aria-pressed={state === 'active'} className={state === 'active' ? 'active' : ''} onClick={() => setState('active')}><span>Active</span><b>{counts.active || 0}</b></button>
        <button type="button" aria-pressed={state === 'inactive'} className={state === 'inactive' ? 'active' : ''} onClick={() => setState('inactive')}><span>Inactive</span><b>{counts.inactive || 0}</b></button>
        <div className="adm-summary-metric"><span>Utilizări active</span><b>{counts.usageCount || 0}</b></div>
        <div className="adm-summary-metric"><span>Reduceri acordate</span><b>{money(counts.discountSum || 0)}</b></div>
      </section>
      <section className="adm-orders-panel adm-promos-panel">
        <div className="adm-toolbar"><div className="adm-search"><Search size={18}/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Caută cod" aria-label="Caută cod promo"/></div><select value={state} onChange={(event) => setState(event.target.value)} aria-label="Filtru stare promo"><option value="all">Toate stările</option><option value="active">Active</option><option value="inactive">Inactive</option></select>{(query || state !== 'all') && <button className="adm-clear" type="button" onClick={() => { setSearch(''); setState('all'); }}>Resetează</button>}</div>
        {!scopesReady && <div className={`adm-scope-alert${scopeError ? ' adm-error' : ''}`} role={scopeError ? 'alert' : 'status'}>
          {scopesLoading ? <LoaderCircle className="adm-spin" size={16}/> : <AlertTriangle size={16}/>}<span>{scopeError || 'Se încarcă selecțiile catalogului…'}</span>
          {scopeError && <button className="adm-compact-btn" type="button" onClick={loadScopes} disabled={scopesLoading}>Reîncearcă</button>}
        </div>}
        {error && <div className="adm-list-message adm-error" role="alert"><AlertTriangle size={18}/>{error}</div>}
        {!error && !loading && !items.length && <div className="adm-list-message"><TicketPercent size={24}/>Nu sunt coduri promo</div>}
        <div className="adm-table-wrap"><table className="adm-table adm-promos-table"><thead><tr><th>Cod</th><th>Reducere</th><th>Perioadă</th><th>Limite</th><th>Utilizări</th><th>Reducere acordată</th><th>Stare</th><th aria-label="Acțiune"/></tr></thead><tbody>{items.map((promo) => <tr key={promo.id} onClick={() => open(promo.id)}><td><b>{promo.code}</b><span>{promo.categoryScopeCount || promo.brandScopeCount || promo.productScopeCount ? `${promo.categoryScopeCount} categorii · ${promo.brandScopeCount} branduri · ${promo.productScopeCount} produse` : 'Tot catalogul'}</span></td><td><strong>{promo.discountType === 'percent' ? `${promo.discountValue}%` : money(promo.discountValue)}</strong>{promo.maxDiscount != null && <span>max. {money(promo.maxDiscount)}</span>}</td><td>{promo.startsAt ? dateTime(promo.startsAt) : 'Imediat'}<span>{promo.endsAt ? `până ${dateTime(promo.endsAt)}` : 'fără expirare'}</span></td><td>{promo.totalUseLimit == null ? 'Total: ∞' : `Total: ${promo.totalUseLimit}`}<span>{promo.perUserLimit == null ? 'Oaspeți permiși' : `${promo.perUserLimit}/client · cont obligatoriu`}</span></td><td><strong>{promo.usageCount}</strong><span>istoric {promo.lifetimeUsageCount}</span></td><td><strong>{money(promo.discountSum)}</strong></td><td><PromoState promo={promo}/></td><td><button className="adm-row-open" type="button" aria-label={`Deschide promoția ${promo.code}`} onClick={(event) => { event.stopPropagation(); open(promo.id); }}><ChevronRight size={18}/></button></td></tr>)}</tbody></table>{loading && <div className="adm-table-loading" role="status" aria-label="Se încarcă promoțiile"><LoaderCircle className="adm-spin" size={24}/></div>}</div>
        <footer className="adm-pagination"><span>{items.length} coduri · {counts.usageCount || 0} utilizări active · {money(counts.discountSum || 0)}</span></footer>
      </section>
      {selectedId && <PromoEditor key={selectedId} promo={detail} creating={creating} categories={categories} brands={brands} scopesReady={scopesReady} scopesLoading={scopesLoading} scopeError={scopeError} onRetryScopes={loadScopes} loading={detailLoading} error={detailError} onClose={close} onSave={save} onDeactivate={deactivate} onUnauthorized={onUnauthorized}/>}
    </>
  );
}
