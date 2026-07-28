import React from 'react';
import {
  AlertTriangle,
  Archive,
  ChevronRight,
  FolderTree,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  X,
} from 'lucide-react';
import { AdminApiError, adminRequest } from '../admin-api.js';
import { useDialogFocus } from '../dialog-a11y.js';

const dateTime = (value) => value
  ? new Intl.DateTimeFormat('ro-MD', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : '—';
const slugify = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80)
  .replace(/-+$/g, '');

const emptyCategory = (sortOrder = 0) => ({
  id: '',
  revision: '',
  slug: '',
  nameRo: '',
  nameRu: '',
  sortOrder: String(sortOrder),
  isActive: true,
  seoTitleRo: '',
  seoTitleRu: '',
  seoDescriptionRo: '',
  seoDescriptionRu: '',
  productCount: 0,
  activeProductCount: 0,
});
const categoryForm = (category, sortOrder = 0) => category ? {
  ...category,
  sortOrder: String(category.sortOrder),
} : emptyCategory(sortOrder);
const categoryPayload = (form) => ({
  ...(form.id ? { revision: form.revision } : { slug: form.slug }),
  nameRo: form.nameRo,
  nameRu: form.nameRu,
  sortOrder: Number(form.sortOrder || 0),
  isActive: form.isActive,
  seoTitleRo: form.seoTitleRo,
  seoTitleRu: form.seoTitleRu,
  seoDescriptionRo: form.seoDescriptionRo,
  seoDescriptionRu: form.seoDescriptionRu,
});

function CategoryState({ category }) {
  return <span className={`adm-product-state ${category.isActive ? 'active' : 'inactive'}`}>{category.isActive ? 'Activă' : 'Inactivă'}</span>;
}

function CategoryEditor({ category, nextSortOrder, onClose, onSave, onDelete }) {
  const initial = categoryForm(category, nextSortOrder);
  const [form, setForm] = React.useState(initial);
  const [baseline, setBaseline] = React.useState(() => JSON.stringify(categoryPayload(initial)));
  const [slugTouched, setSlugTouched] = React.useState(Boolean(category));
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState('');
  const [deleteConfirm, setDeleteConfirm] = React.useState(false);
  const [closeConfirm, setCloseConfirm] = React.useState(false);
  const dirty = React.useMemo(() => JSON.stringify(categoryPayload(form)) !== baseline, [baseline, form]);
  const newCategory = !form.id;

  const discardAndClose = React.useCallback(() => onClose(), [onClose]);
  const requestClose = React.useCallback(() => {
    if (dirty) setCloseConfirm(true);
    else discardAndClose();
  }, [dirty, discardAndClose]);
  const dialogRef = useDialogFocus(() => {
    if (closeConfirm) setCloseConfirm(false);
    else requestClose();
  });
  React.useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const setName = (value) => setForm((current) => ({
    ...current,
    nameRo: value,
    ...(!current.id && !slugTouched ? { slug: slugify(value) } : {}),
  }));
  const submit = async (event) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setSaveError('');
    try {
      const saved = await onSave(categoryPayload(form));
      const next = categoryForm(saved);
      setForm(next);
      setBaseline(JSON.stringify(categoryPayload(next)));
      setCloseConfirm(false);
    } catch (error) {
      setSaveError(error.message);
    } finally {
      setSaving(false);
    }
  };
  const deactivate = async () => {
    if (!form.id || saving) return;
    setSaving(true);
    setSaveError('');
    try {
      const deleted = await onDelete(form.revision);
      const next = categoryForm(deleted);
      setForm(next);
      setBaseline(JSON.stringify(categoryPayload(next)));
      setDeleteConfirm(false);
      setCloseConfirm(false);
    } catch (error) {
      setSaveError(error.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="adm-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
      <aside className="adm-drawer adm-category-drawer" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Editor categorie" tabIndex={-1}>
        <form onSubmit={submit}>
          <header className="adm-drawer-head">
            <div><span>{newCategory ? 'Categorie nouă' : form.slug}</span><h2>{newCategory ? 'Adaugă categorie' : form.nameRo}</h2></div>
            <button className="adm-icon-btn" type="button" onClick={requestClose} title="Închide" aria-label="Închide" data-dialog-initial-focus><X size={20}/></button>
          </header>
          <div className="adm-drawer-body adm-category-form">
            <section className="adm-form-section">
              <h3>Identificare</h3>
              <div className="adm-form-grid">
                <label className="wide"><span>Denumire RO</span><input value={form.nameRo} onChange={(event) => setName(event.target.value)} required maxLength={180}/></label>
                <label className="wide"><span>Denumire RU</span><input value={form.nameRu} onChange={(event) => set('nameRu', event.target.value)} maxLength={180}/></label>
                <label className="wide"><span>Cheie URL</span><input className={!newCategory ? 'readonly' : ''} value={form.slug} onChange={(event) => { setSlugTouched(true); set('slug', slugify(event.target.value)); }} readOnly={!newCategory} required minLength={2} maxLength={80}/></label>
                <label><span>Ordine</span><input type="number" min="0" max="9999" step="1" value={form.sortOrder} onChange={(event) => set('sortOrder', event.target.value)} required/></label>
                <label className="adm-check adm-category-active"><input type="checkbox" checked={form.isActive} disabled={form.isActive && form.productCount > 0} onChange={(event) => set('isActive', event.target.checked)}/><span>Activă</span></label>
              </div>
            </section>
            <section className="adm-form-section">
              <h3>SEO</h3>
              <div className="adm-form-grid">
                <label className="wide"><span>Titlu RO</span><input value={form.seoTitleRo} onChange={(event) => set('seoTitleRo', event.target.value)} maxLength={300}/></label>
                <label className="wide"><span>Titlu RU</span><input value={form.seoTitleRu} onChange={(event) => set('seoTitleRu', event.target.value)} maxLength={300}/></label>
                <label className="wide"><span>Descriere RO</span><textarea value={form.seoDescriptionRo} onChange={(event) => set('seoDescriptionRo', event.target.value)} maxLength={1000}/></label>
                <label className="wide"><span>Descriere RU</span><textarea value={form.seoDescriptionRu} onChange={(event) => set('seoDescriptionRu', event.target.value)} maxLength={1000}/></label>
              </div>
            </section>
          </div>
          {saveError && <div className="adm-editor-error" role="alert"><AlertTriangle size={16}/>{saveError}</div>}
          <footer className="adm-editor-footer">
            {closeConfirm ? (
              <div className="adm-unsaved-confirm">
                <AlertTriangle size={17}/><span>Modificări nesalvate</span>
                <button type="button" onClick={() => setCloseConfirm(false)}>Rămân</button>
                <button type="button" className="danger" onClick={discardAndClose}>Renunță</button>
              </div>
            ) : (
              <>
                {!newCategory && form.isActive && (
                  deleteConfirm ? (
                    <div className="adm-delete-confirm"><span>Dezactivezi categoria?</span><button type="button" onClick={() => setDeleteConfirm(false)}>Nu</button><button type="button" className="danger" onClick={deactivate}>Da</button></div>
                  ) : <button className="adm-danger-btn" type="button" disabled={form.productCount > 0} onClick={() => setDeleteConfirm(true)} title={form.productCount > 0 ? 'Categoria conține produse' : 'Dezactivează'}><Archive size={16}/>Șterge</button>
                )}
                {!newCategory && !form.isActive && <button className="adm-compact-btn" type="button" onClick={() => set('isActive', true)}><RotateCcw size={16}/>Restabilește</button>}
                <button className="adm-primary" type="submit" disabled={saving}>
                  {saving ? <LoaderCircle className="adm-spin" size={17}/> : <Save size={17}/>}Salvează
                </button>
              </>
            )}
          </footer>
        </form>
      </aside>
    </div>
  );
}

export default function AdminCategories({ onUnauthorized }) {
  const [categories, setCategories] = React.useState([]);
  const [counts, setCounts] = React.useState({ active: 0, inactive: 0, total: 0 });
  const [search, setSearch] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [state, setState] = React.useState('all');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [selected, setSelected] = React.useState(null);
  const [creating, setCreating] = React.useState(false);

  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const loadCategories = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ state });
      if (query) params.set('q', query);
      const payload = await adminRequest(`/api/admin/categories?${params}`);
      setCategories(payload.items);
      setCounts(payload.counts);
    } catch (requestError) {
      setError(requestError.message);
      if (requestError instanceof AdminApiError && [401, 403].includes(requestError.status)) onUnauthorized();
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized, query, state]);
  React.useEffect(() => { loadCategories(); }, [loadCategories]);

  const closeEditor = React.useCallback(() => { setSelected(null); setCreating(false); }, []);
  const save = async (body) => {
    try {
      const response = await adminRequest(creating ? '/api/admin/categories' : `/api/admin/categories/${encodeURIComponent(selected.id)}`, {
        method: creating ? 'POST' : 'PATCH',
        body,
      });
      setCreating(false);
      setSelected(response.category);
      await loadCategories();
      return response.category;
    } catch (requestError) {
      if (requestError instanceof AdminApiError && [401, 403].includes(requestError.status)) onUnauthorized();
      throw requestError;
    }
  };
  const remove = async (revision) => {
    try {
      const response = await adminRequest(`/api/admin/categories/${encodeURIComponent(selected.id)}`, { method: 'DELETE', body: { revision } });
      setSelected(response.category);
      await loadCategories();
      return response.category;
    } catch (requestError) {
      if (requestError instanceof AdminApiError && [401, 403].includes(requestError.status)) onUnauthorized();
      throw requestError;
    }
  };
  const nextSortOrder = categories.reduce((maximum, category) => Math.max(maximum, category.sortOrder), -1) + 1;

  return (
    <>
      <header className="adm-topbar adm-categories-topbar">
        <div><span>Catalog</span><h1>Categorii</h1></div>
        <div>
          <button className="adm-icon-btn" type="button" onClick={loadCategories} title="Actualizează"><RefreshCw className={loading ? 'adm-spin' : ''} size={19}/></button>
          <button className="adm-primary" type="button" onClick={() => { setCreating(true); setSelected(null); }}><Plus size={18}/>Categorie nouă</button>
        </div>
      </header>

      <section className="adm-summary adm-category-summary" aria-label="Sumar categorii">
        <button type="button" className={state === 'all' ? 'active' : ''} onClick={() => setState('all')}><span>Total</span><b>{counts.total}</b></button>
        <button type="button" className={state === 'active' ? 'active' : ''} onClick={() => setState('active')}><span>Active</span><b>{counts.active}</b></button>
        <button type="button" className={state === 'inactive' ? 'active' : ''} onClick={() => setState('inactive')}><span>Inactive</span><b>{counts.inactive}</b></button>
      </section>

      <section className="adm-orders-panel adm-categories-panel">
        <div className="adm-toolbar adm-category-toolbar">
          <div className="adm-search"><Search size={18}/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Denumire sau cheie URL" aria-label="Caută categorii"/></div>
          <select value={state} onChange={(event) => setState(event.target.value)} aria-label="Filtru stare"><option value="all">Toate stările</option><option value="active">Active</option><option value="inactive">Inactive</option></select>
          {(query || state !== 'all') && <button className="adm-clear" type="button" onClick={() => { setSearch(''); setState('all'); }}>Resetează</button>}
        </div>
        {error && <div className="adm-list-message adm-error"><AlertTriangle size={18}/>{error}</div>}
        {!error && !loading && categories.length === 0 && <div className="adm-list-message"><FolderTree size={24}/>Nu sunt categorii</div>}
        <div className="adm-table-wrap">
          <table className="adm-table adm-categories-table">
            <thead><tr><th>Categorie</th><th>Cheie URL</th><th>Produse active</th><th>Total produse</th><th>Ordine</th><th>Stare</th><th>Actualizat</th><th aria-label="Acțiune"/></tr></thead>
            <tbody>
              {categories.map((category) => (
                <tr key={category.id} onClick={() => { setCreating(false); setSelected(category); }}>
                  <td><div className="adm-category-cell"><FolderTree size={18}/><div><b>{category.nameRo}</b><span>{category.nameRu || '—'}</span></div></div></td>
                  <td><code>{category.slug}</code></td>
                  <td><strong>{category.activeProductCount}</strong></td>
                  <td>{category.productCount}</td>
                  <td>{category.sortOrder}</td>
                  <td><CategoryState category={category}/></td>
                  <td>{dateTime(category.updatedAt)}</td>
                  <td><button className="adm-row-open" type="button" title="Deschide" onClick={(event) => { event.stopPropagation(); setCreating(false); setSelected(category); }}><ChevronRight size={18}/></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <div className="adm-table-loading"><LoaderCircle className="adm-spin" size={24}/></div>}
        </div>
        <footer className="adm-pagination"><span>{categories.length} din {counts.total} categorii</span></footer>
      </section>

      {(creating || selected) && <CategoryEditor key={creating ? 'new' : selected.id} category={selected} nextSortOrder={nextSortOrder} onClose={closeEditor} onSave={save} onDelete={remove}/>}
    </>
  );
}
