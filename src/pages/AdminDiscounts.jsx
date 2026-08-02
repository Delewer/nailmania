import React from 'react';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  LoaderCircle,
  Percent,
  Plus,
  RefreshCw,
  Search,
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
const foldBrand = (value) => String(value || '').trim().toLocaleLowerCase('ro');

const discountDraftFingerprint = (draft, discountId) => JSON.stringify({
  discountId: discountId || null,
  revision: String(draft.revision || ''),
  name: String(draft.name || '').trim(),
  percentage: Number(draft.percentage),
  startsAt: draft.startsAt || null,
  endsAt: draft.endsAt || null,
  isActive: Boolean(draft.isActive),
  categoryIds: [...(draft.categoryIds || [])].map(String).sort(),
  brands: [...(draft.brands || [])].map(foldBrand).sort(),
  productIds: [...(draft.productIds || [])].map(Number).sort((left, right) => left - right),
});

const categoryScopeOptions = (available, selected, selectedIds) => {
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

const brandScopeOptions = (available, selectedNames) => {
  const options = [...available];
  const known = new Set(available.map((brand) => foldBrand(brand.name)));
  for (const name of selectedNames) {
    if (known.has(foldBrand(name))) continue;
    options.push({ name, productCount: null, unavailable: true });
  }
  return options;
};

const emptyDiscount = () => ({
  id: 'new',
  name: '',
  percentage: 10,
  startsAt: null,
  endsAt: null,
  isActive: true,
  revision: '',
  categories: [],
  brands: [],
  products: [],
  affectedProductCount: 0,
});

const discountForm = (discount) => ({
  name: discount?.name || '',
  percentage: String(discount?.percentage ?? 10),
  startsAt: localDateTime(discount?.startsAt),
  endsAt: localDateTime(discount?.endsAt),
  isActive: discount?.isActive ?? true,
});

function DiscountState({ discount }) {
  const now = Date.now();
  let label = 'Activă';
  let tone = 'active';
  if (!discount.isActive) { label = 'Inactivă'; tone = 'inactive'; }
  else if (discount.startsAt && Date.parse(discount.startsAt) > now) { label = 'Programată'; tone = 'scheduled'; }
  else if (discount.endsAt && Date.parse(discount.endsAt) <= now) { label = 'Expirată'; tone = 'expired'; }
  return <span className={`adm-product-state ${tone}`}>{label}</span>;
}

function DiscountEditor({ discount, creating, scopes, loading, error, onClose, onSave, onDeactivate, onUnauthorized }) {
  const [form, setForm] = React.useState(() => discountForm(discount || emptyDiscount()));
  const [categoryIds, setCategoryIds] = React.useState(() => (discount?.categories || []).map((item) => item.id));
  const [brandNames, setBrandNames] = React.useState(() => discount?.brands || []);
  const [products, setProducts] = React.useState(() => discount?.products || []);
  const [preview, setPreview] = React.useState(null);
  const [previewing, setPreviewing] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState('');
  const previewSequence = React.useRef(0);
  const currentFingerprint = React.useRef('');
  const dialogRef = useDialogFocus(() => { if (!saving) onClose(); });

  const invalidatePreview = React.useCallback(() => {
    previewSequence.current += 1;
    setPreview(null);
    setPreviewing(false);
  }, []);

  React.useEffect(() => {
    if (!discount) return;
    setForm(discountForm(discount));
    setCategoryIds((discount.categories || []).map((item) => item.id));
    setBrandNames(discount.brands || []);
    setProducts(discount.products || []);
    invalidatePreview();
  }, [discount, invalidatePreview]);

  const set = (key) => (event) => {
    const next = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm((current) => ({ ...current, [key]: next }));
    invalidatePreview();
  };
  const toggleCategory = (id) => {
    setCategoryIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
    invalidatePreview();
  };
  const toggleBrand = (name) => {
    setBrandNames((current) => current.some((item) => foldBrand(item) === foldBrand(name))
      ? current.filter((item) => foldBrand(item) !== foldBrand(name))
      : [...current, name]);
    invalidatePreview();
  };
  const changeProducts = (next) => { setProducts(next); invalidatePreview(); };
  const body = () => ({
    name: form.name.trim(),
    percentage: Number(form.percentage),
    startsAt: isoDateTime(form.startsAt),
    endsAt: isoDateTime(form.endsAt),
    isActive: Boolean(form.isActive),
    categoryIds,
    brands: brandNames,
    productIds: products.map((product) => Number(product.id)),
    ...(!creating && discount ? { revision: discount.revision } : {}),
  });
  const draft = body();
  const fingerprint = discountDraftFingerprint(draft, creating ? null : discount?.id);
  currentFingerprint.current = fingerprint;
  const loadPreview = async () => {
    if (previewing) return;
    const sequence = ++previewSequence.current;
    const previewDraft = body();
    const discountId = creating ? null : discount.id;
    const requestedFingerprint = discountDraftFingerprint(previewDraft, discountId);
    setPreview(null);
    setPreviewing(true);
    setSaveError('');
    try {
      const payload = await adminRequest('/api/admin/discounts/preview', {
        method: 'POST',
        body: { ...previewDraft, discountId },
      });
      if (sequence !== previewSequence.current || requestedFingerprint !== currentFingerprint.current) return;
      const responseId = payload.discountId || null;
      const responseRevision = String(payload.revision || '');
      if (responseId !== discountId || responseRevision !== String(previewDraft.revision || '')) {
        setSaveError('Reducerea s-a modificat între timp. Reîncarcă și calculează din nou.');
        return;
      }
      setPreview({ ...payload, draftFingerprint: requestedFingerprint });
    } catch (caught) {
      if (caught instanceof AdminApiError && [401, 403].includes(caught.status)) onUnauthorized?.();
      if (sequence === previewSequence.current) setSaveError(caught.message);
    } finally {
      if (sequence === previewSequence.current) setPreviewing(false);
    }
  };
  const submit = async (event) => {
    event.preventDefault();
    if (!discount || saving) return;
    if (!hasScope || (form.isActive && (
      !previewIsCurrent
      || !preview?.appliesAtEvaluation
      || Number(preview?.affectedCount || 0) <= 0
    ))) {
      setSaveError(previewIsCurrent && !preview?.appliesAtEvaluation
        ? 'Perioada aleasă este deja expirată. Modifică datele sau dezactivează reducerea.'
        : 'Calculează produsele afectate înainte de a activa reducerea.');
      return;
    }
    setSaving(true);
    setSaveError('');
    try { await onSave(discount.id, body(), creating); }
    catch (caught) {
      if (caught instanceof AdminApiError && [401, 403].includes(caught.status)) onUnauthorized?.();
      setSaveError(caught.message);
    }
    finally { setSaving(false); }
  };
  const deactivate = async () => {
    if (!discount || creating || saving || !discount.isActive) return;
    setSaving(true);
    setSaveError('');
    try { await onDeactivate(discount.id, discount.revision); }
    catch (caught) {
      if (caught instanceof AdminApiError && [401, 403].includes(caught.status)) onUnauthorized?.();
      setSaveError(caught.message);
    }
    finally { setSaving(false); }
  };

  const hasScope = categoryIds.length + brandNames.length + products.length > 0;
  const previewIsCurrent = preview?.draftFingerprint === fingerprint;
  const canSave = hasScope && (!form.isActive || (
    previewIsCurrent
    && preview?.appliesAtEvaluation
    && Number(preview?.affectedCount || 0) > 0
  ));
  const categoryOptions = categoryScopeOptions(scopes.categories, discount?.categories || [], categoryIds);
  const brandOptions = brandScopeOptions(scopes.brands, brandNames);
  return (
    <div className="adm-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <aside className="adm-drawer adm-promo-drawer" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Editor reducere catalog" tabIndex={-1}>
        <header className="adm-drawer-head"><div><span>Reducere catalog</span><h2>{creating ? 'Reducere nouă' : discount?.name || 'Se încarcă'}</h2></div><button className="adm-icon-btn" type="button" onClick={onClose} disabled={saving} aria-label="Închide" data-dialog-initial-focus><X size={20}/></button></header>
        {loading && <div className="adm-table-loading" role="status" aria-label="Se încarcă reducerea"><LoaderCircle className="adm-spin" size={24}/></div>}
        {error && <div className="adm-list-message adm-error" role="alert"><AlertTriangle size={18}/>{error}</div>}
        {discount && !loading && <form onSubmit={submit} className="adm-promo-form">
          <div className="adm-form-section">
            <h3>Condițiile reducerii</h3>
            <div className="adm-form-grid adm-promo-grid">
              <label className="full"><span>Denumire internă</span><input value={form.name} onChange={set('name')} maxLength={180} required placeholder="Ex. Reducere vară −20%"/></label>
              <label><span>Reducere (%)</span><input type="number" min="1" max="99" step="1" value={form.percentage} onChange={set('percentage')} required/></label>
              <label className="adm-check adm-promo-active"><input type="checkbox" checked={form.isActive} onChange={set('isActive')}/><span>Reducere activă</span></label>
              <label><span>Începe la</span><input type="datetime-local" value={form.startsAt} onChange={set('startsAt')}/></label>
              <label><span>Expiră la</span><input type="datetime-local" value={form.endsAt} onChange={set('endsAt')}/></label>
            </div>
          </div>
          <div className="adm-form-section">
            <h3>Categorii întregi</h3>
            <p className="adm-form-hint">Produsele, categoriile și brandurile selectate se reunesc. Trebuie aleasă cel puțin o zonă.</p>
            <div className="adm-promo-category-grid adm-scope-grid">{categoryOptions.map((category) => <label className="adm-check" key={category.id}><input type="checkbox" checked={categoryIds.includes(category.id)} onChange={() => toggleCategory(category.id)}/><span>{category.nameRo}<small>{category.unavailable ? 'indisponibilă' : `${category.productCount} produse`}</small></span></label>)}</div>
          </div>
          <div className="adm-form-section">
            <h3>Branduri întregi</h3>
            <div className="adm-promo-category-grid adm-scope-grid">{brandOptions.map((brand) => <label className="adm-check" key={brand.name}><input type="checkbox" checked={brandNames.some((name) => foldBrand(name) === foldBrand(brand.name))} onChange={() => toggleBrand(brand.name)}/><span>{brand.name}<small>{brand.unavailable ? 'indisponibil' : `${brand.productCount} produse`}</small></span></label>)}</div>
          </div>
          <div className="adm-form-section"><h3>Produse individuale</h3><AdminProductScopePicker selected={products} onChange={changeProducts} label="reducere" onUnauthorized={onUnauthorized} disabled={saving}/></div>
          <div className="adm-form-section adm-discount-preview">
            <div className="adm-section-head"><h3>Verificare înainte de salvare</h3><button className="adm-compact-btn" type="button" onClick={loadPreview} disabled={!hasScope || previewing}>{previewing ? <LoaderCircle className="adm-spin" size={15}/> : <Search size={15}/>}Calculează</button></div>
            {!preview && <p className="adm-form-hint">Vezi câte produse vor fi afectate și câteva prețuri înainte de activare.</p>}
            {previewIsCurrent && <><strong>{preview.affectedCount} produse afectate</strong><p className="adm-form-hint">Calcul pentru {dateTime(preview.evaluatedAt)}{preview.appliesAtEvaluation ? '' : ' · reducerea nu este valabilă la această dată'}</p><div className="adm-discount-sample">{preview.sample.map((product) => <div key={product.id}><span><b>{product.name}</b><small>{product.sku || product.key} · {product.brand}</small></span><span><small>Acum: {money(product.currentPrice)}</small><b>Calculat: {money(product.previewPrice)}</b></span></div>)}</div></>}
          </div>
          {saveError && <div className="adm-list-message adm-error" role="alert"><AlertTriangle size={18}/>{saveError}</div>}
          <footer className="adm-promo-actions">
            {!creating && discount.isActive && <button className="adm-compact-btn danger" type="button" onClick={deactivate} disabled={saving}><Trash2 size={15}/>Dezactivează</button>}
            <button className="adm-primary" type="submit" disabled={saving || !canSave} title={form.isActive && !previewIsCurrent ? 'Calculează produsele afectate înainte de activare' : ''}>{saving ? <LoaderCircle className="adm-spin" size={17}/> : <Check size={17}/>}Salvează</button>
          </footer>
        </form>}
      </aside>
    </div>
  );
}

export default function AdminDiscounts({ onUnauthorized }) {
  const [items, setItems] = React.useState([]);
  const [counts, setCounts] = React.useState({});
  const [scopes, setScopes] = React.useState({ categories: [], brands: [] });
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

  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  React.useEffect(() => {
    adminRequest('/api/admin/catalog-scopes').then((payload) => setScopes({ categories: payload.categories, brands: payload.brands })).catch((caught) => {
      if (caught instanceof AdminApiError && [401, 403].includes(caught.status)) onUnauthorized?.();
      setError(caught.message);
    });
  }, [onUnauthorized]);
  const load = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ state });
      if (query) params.set('q', query);
      const payload = await adminRequest(`/api/admin/discounts?${params}`);
      setItems(payload.items);
      setCounts(payload.counts);
    } catch (caught) {
      setError(caught.message);
      if (caught instanceof AdminApiError && [401, 403].includes(caught.status)) onUnauthorized?.();
    } finally { setLoading(false); }
  }, [onUnauthorized, query, state]);
  React.useEffect(() => { load(); }, [load]);

  const open = async (id) => {
    setSelectedId(id); setCreating(false); setDetail(null); setDetailError(''); setDetailLoading(true);
    try { setDetail((await adminRequest(`/api/admin/discounts/${encodeURIComponent(id)}`)).discount); }
    catch (caught) { setDetailError(caught.message); if (caught instanceof AdminApiError && [401, 403].includes(caught.status)) onUnauthorized?.(); }
    finally { setDetailLoading(false); }
  };
  const create = () => { setCreating(true); setSelectedId('new'); setDetail(emptyDiscount()); setDetailError(''); setDetailLoading(false); };
  const close = () => { setSelectedId(''); setDetail(null); setDetailError(''); setCreating(false); };
  const save = async (id, body, isNew) => {
    const payload = await adminRequest(isNew ? '/api/admin/discounts' : `/api/admin/discounts/${encodeURIComponent(id)}`, {
      method: isNew ? 'POST' : 'PATCH', body,
    });
    setDetail(payload.discount); setSelectedId(payload.discount.id); setCreating(false); await load();
  };
  const deactivate = async (id, revision) => {
    const payload = await adminRequest(`/api/admin/discounts/${encodeURIComponent(id)}`, { method: 'DELETE', body: { revision } });
    setDetail(payload.discount); await load();
  };

  return <>
    <header className="adm-topbar adm-promos-topbar"><div><span>Catalog</span><h1>Reduceri</h1></div><div><button className="adm-icon-btn" type="button" onClick={load} title="Actualizează" aria-label="Actualizează reducerile"><RefreshCw className={loading ? 'adm-spin' : ''} size={19}/></button><button className="adm-primary" type="button" onClick={create}><Plus size={18}/>Reducere nouă</button></div></header>
    <section className="adm-summary adm-promo-summary" aria-label="Sumar reduceri">
      <button type="button" aria-pressed={state === 'all'} className={state === 'all' ? 'active' : ''} onClick={() => setState('all')}><span>Total</span><b>{counts.total || 0}</b></button>
      <button type="button" aria-pressed={state === 'active'} className={state === 'active' ? 'active' : ''} onClick={() => setState('active')}><span>Activate</span><b>{counts.active || 0}</b></button>
      <button type="button" aria-pressed={state === 'inactive'} className={state === 'inactive' ? 'active' : ''} onClick={() => setState('inactive')}><span>Dezactivate</span><b>{counts.inactive || 0}</b></button>
      <div className="adm-summary-metric"><span>Vizări în campanii</span><b>{items.reduce((sum, item) => sum + Number(item.affectedProductCount || 0), 0)}</b></div>
      <div className="adm-summary-metric"><span>Tip</span><b><Percent size={18}/> catalog</b></div>
    </section>
    <section className="adm-orders-panel adm-promos-panel">
      <div className="adm-toolbar"><div className="adm-search"><Search size={18}/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Caută reducerea" aria-label="Caută reducerea"/></div><select value={state} onChange={(event) => setState(event.target.value)} aria-label="Filtru stare reducere"><option value="all">Toate stările</option><option value="active">Activate</option><option value="inactive">Dezactivate</option></select>{(query || state !== 'all') && <button className="adm-clear" type="button" onClick={() => { setSearch(''); setState('all'); }}>Resetează</button>}</div>
      {error && <div className="adm-list-message adm-error" role="alert"><AlertTriangle size={18}/>{error}</div>}
      {!error && !loading && !items.length && <div className="adm-list-message"><Percent size={24}/>Nu sunt reduceri</div>}
      <div className="adm-table-wrap"><table className="adm-table adm-discounts-table"><thead><tr><th>Reducere</th><th>Procent</th><th>Perioadă</th><th>Selecție</th><th>Produse</th><th>Stare</th><th aria-label="Acțiune"/></tr></thead><tbody>{items.map((discount) => <tr key={discount.id} onClick={() => open(discount.id)}><td><b>{discount.name}</b><span>actualizată {dateTime(discount.updatedAt)}</span></td><td><strong>−{discount.percentage}%</strong></td><td>{discount.startsAt ? dateTime(discount.startsAt) : 'Imediat'}<span>{discount.endsAt ? `până ${dateTime(discount.endsAt)}` : 'fără expirare'}</span></td><td>{discount.categoryScopeCount} categorii<span>{discount.brandScopeCount} branduri · {discount.productScopeCount} produse</span></td><td><strong>{discount.affectedProductCount}</strong></td><td><DiscountState discount={discount}/></td><td><button className="adm-row-open" type="button" aria-label={`Deschide reducerea ${discount.name}`} onClick={(event) => { event.stopPropagation(); open(discount.id); }}><ChevronRight size={18}/></button></td></tr>)}</tbody></table>{loading && <div className="adm-table-loading" role="status" aria-label="Se încarcă reducerile"><LoaderCircle className="adm-spin" size={24}/></div>}</div>
    </section>
    {selectedId && <DiscountEditor key={selectedId} discount={detail} creating={creating} scopes={scopes} loading={detailLoading} error={detailError} onClose={close} onSave={save} onDeactivate={deactivate} onUnauthorized={onUnauthorized}/>}
  </>;
}
