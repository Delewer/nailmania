import React from 'react';
import {
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Boxes,
  ChevronRight,
  Image as ImageIcon,
  LoaderCircle,
  PackagePlus,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { AdminApiError, adminRequest } from '../admin-api.js';
import { handleTabListKeyDown, useDialogFocus } from '../dialog-a11y.js';

const PAGE_SIZE = 30;
const PRODUCT_TABS = ['general', 'images', 'stock'];
const money = (value) => `${new Intl.NumberFormat('ro-MD').format(Number(value || 0))} lei`;
const dateTime = (value) => value
  ? new Intl.DateTimeFormat('ro-MD', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : '—';

const emptyProduct = (categoryId = '') => ({
  id: null,
  revision: '',
  inventoryRevision: '',
  sku: '',
  key: '',
  categoryId,
  brand: 'Fără brand',
  nameRo: '',
  nameRu: '',
  descriptionRo: '',
  descriptionRu: '',
  price: '',
  oldPrice: '0',
  costPrice: '',
  lowStockThreshold: '2',
  initialStock: '0',
  isActive: true,
  isFeatured: false,
  isNew: false,
  isPromo: false,
  isSummer: false,
  specs: [],
  images: [],
  movements: [],
  onHand: 0,
  reserved: 0,
  available: 0,
  isDeleted: false,
});

const productForm = (product, categoryId) => product ? {
  ...product,
  price: String(product.price),
  oldPrice: String(product.oldPrice),
  costPrice: product.costPrice === null ? '' : String(product.costPrice),
  lowStockThreshold: String(product.lowStockThreshold),
  initialStock: String(product.onHand),
  specs: product.specs.map((item) => ({ ...item })),
  images: product.images.map((item) => ({ ...item })),
} : emptyProduct(categoryId);

const productPayload = (form) => ({
  ...(form.id ? { revision: form.revision } : { initialStock: Number(form.initialStock || 0) }),
  sku: form.sku,
  categoryId: form.categoryId,
  brand: form.brand,
  nameRo: form.nameRo,
  nameRu: form.nameRu,
  descriptionRo: form.descriptionRo,
  descriptionRu: form.descriptionRu,
  price: Number(form.price),
  oldPrice: Number(form.oldPrice || 0),
  costPrice: form.costPrice === '' ? null : Number(form.costPrice),
  lowStockThreshold: Number(form.lowStockThreshold || 0),
  isActive: form.isActive,
  isFeatured: form.isFeatured,
  isNew: form.isNew,
  isPromo: form.isPromo,
  isSummer: form.isSummer,
  specs: form.specs,
  images: form.images.map(({ url, objectKey, altRo, altRu }) => ({ url, objectKey, altRo, altRu })),
});

function ProductState({ product }) {
  if (product.isDeleted) return <span className="adm-product-state inactive">Șters</span>;
  if (!product.isActive) return <span className="adm-product-state inactive">Inactiv</span>;
  if (product.available <= 0) return <span className="adm-product-state out">Fără stoc</span>;
  if (product.available <= product.lowStockThreshold) return <span className="adm-product-state low">Stoc redus</span>;
  return <span className="adm-product-state active">Activ</span>;
}

function ProductEditor({ product, categories, loading, error, onClose, onSave, onDelete, onAdjust, onUpload, onDiscardUpload }) {
  const initialForm = React.useMemo(() => productForm(product, categories[0]?.id), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [form, setForm] = React.useState(initialForm);
  const [savedSnapshot, setSavedSnapshot] = React.useState(() => JSON.stringify(productPayload(initialForm)));
  const [tab, setTab] = React.useState('general');
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState('');
  const [deleteConfirm, setDeleteConfirm] = React.useState(false);
  const [closeConfirm, setCloseConfirm] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [imageUrl, setImageUrl] = React.useState('');
  const [stockOperation, setStockOperation] = React.useState('receipt');
  const [stockValue, setStockValue] = React.useState('');
  const [stockReason, setStockReason] = React.useState('');
  const [stockSaving, setStockSaving] = React.useState(false);
  const fileRef = React.useRef(null);
  const pendingUploads = React.useRef([]);

  React.useEffect(() => {
    const nextForm = productForm(product, categories[0]?.id);
    setForm(nextForm);
    setSavedSnapshot(JSON.stringify(productPayload(nextForm)));
    setTab('general');
    setSaveError('');
    setDeleteConfirm(false);
    setCloseConfirm(false);
  }, [product?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    if (!form.categoryId && categories[0]?.id) setForm((current) => ({ ...current, categoryId: categories[0].id }));
  }, [categories, form.categoryId]);
  React.useEffect(() => {
    pendingUploads.current = form.images.filter((image) => image.pending && image.objectKey).map((image) => image.objectKey);
  }, [form.images]);
  const hasUnsavedChanges = React.useMemo(
    () => JSON.stringify(productPayload(form)) !== savedSnapshot || Boolean(stockValue || stockReason.trim()),
    [form, savedSnapshot, stockReason, stockValue],
  );
  const discardAndClose = React.useCallback(async () => {
    const keys = [...pendingUploads.current];
    pendingUploads.current = [];
    await Promise.allSettled(keys.map((key) => onDiscardUpload(key)));
    onClose();
  }, [onClose, onDiscardUpload]);
  const requestClose = React.useCallback(() => {
    if (hasUnsavedChanges) {
      setCloseConfirm(true);
      return;
    }
    void discardAndClose();
  }, [discardAndClose, hasUnsavedChanges]);
  const dialogRef = useDialogFocus(() => {
    if (closeConfirm) setCloseConfirm(false);
    else requestClose();
  });
  React.useEffect(() => {
    if (!hasUnsavedChanges) return undefined;
    const warn = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasUnsavedChanges]);

  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setSaveError('');
    try {
      const saved = await onSave(productPayload(form));
      const nextForm = productForm(saved, categories[0]?.id);
      setForm(nextForm);
      setSavedSnapshot(JSON.stringify(productPayload(nextForm)));
      setCloseConfirm(false);
    } catch (requestError) {
      setSaveError(requestError.message);
    } finally {
      setSaving(false);
    }
  };

  const addSpec = () => set('specs', [...form.specs, { label: '', value: '' }]);
  const updateSpec = (index, key, value) => set('specs', form.specs.map((item, itemIndex) => itemIndex === index ? { ...item, [key]: value } : item));
  const removeSpec = (index) => set('specs', form.specs.filter((_, itemIndex) => itemIndex !== index));
  const moveImage = (index, direction) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= form.images.length) return;
    const images = [...form.images];
    [images[index], images[nextIndex]] = [images[nextIndex], images[index]];
    set('images', images);
  };
  const addImageUrl = () => {
    const url = imageUrl.trim();
    if (!url || form.images.some((image) => image.url === url)) return;
    set('images', [...form.images, { url, objectKey: '', altRo: form.nameRo, altRu: form.nameRu || form.nameRo }]);
    setImageUrl('');
  };
  const upload = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploading(true);
    setSaveError('');
    try {
      const image = await onUpload(file);
      set('images', [...form.images, { ...image, altRo: form.nameRo, altRu: form.nameRu || form.nameRo, pending: true }]);
    } catch (requestError) {
      setSaveError(requestError.message);
    } finally {
      setUploading(false);
    }
  };
  const removeImage = async (index) => {
    const image = form.images[index];
    set('images', form.images.filter((_, itemIndex) => itemIndex !== index));
    if (image?.pending && image.objectKey) {
      try { await onDiscardUpload(image.objectKey); }
      catch (requestError) { setSaveError(requestError.message); }
    }
  };

  const adjustStock = async () => {
    if (!form.id || stockSaving) return;
    setStockSaving(true);
    setSaveError('');
    try {
      const body = {
        revision: form.inventoryRevision,
        operation: stockOperation,
        reason: stockReason,
        ...(stockOperation === 'adjustment' ? { targetOnHand: Number(stockValue) } : { quantity: Number(stockValue) }),
      };
      const updated = await onAdjust(body);
      setForm((current) => ({
        ...current,
        inventoryRevision: updated.inventoryRevision,
        onHand: updated.onHand,
        reserved: updated.reserved,
        available: updated.available,
        movements: updated.movements,
      }));
      setStockValue('');
      setStockReason('');
    } catch (requestError) {
      setSaveError(requestError.message);
    } finally {
      setStockSaving(false);
    }
  };
  const deactivate = async () => {
    if (!form.id || saving) return;
    setSaving(true);
    setSaveError('');
    try {
      const deleted = await onDelete(form.revision);
      const nextForm = productForm(deleted, categories[0]?.id);
      setForm(nextForm);
      setSavedSnapshot(JSON.stringify(productPayload(nextForm)));
      setDeleteConfirm(false);
      setCloseConfirm(false);
    } catch (requestError) {
      setSaveError(requestError.message);
    } finally {
      setSaving(false);
    }
  };

  const newProduct = !form.id;
  return (
    <div className="adm-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
      <aside className="adm-drawer adm-product-drawer" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Editor produs" tabIndex={-1}>
        <form onSubmit={submit}>
          <header className="adm-drawer-head">
            <div><span>{newProduct ? 'Produs nou' : form.sku}</span><h2>{newProduct ? 'Adaugă produs' : form.nameRo}</h2></div>
            <button className="adm-icon-btn" type="button" onClick={requestClose} title="Închide" aria-label="Închide" data-dialog-initial-focus><X size={20}/></button>
          </header>
          {loading && <div className="adm-drawer-state" role="status"><LoaderCircle className="adm-spin" size={24}/>Se încarcă</div>}
          {error && <div className="adm-drawer-state adm-error" role="alert"><AlertTriangle size={20}/>{error}</div>}
          {!loading && !error && (
            <>
              <div className="adm-tabs adm-product-tabs" role="tablist" aria-label="Secțiuni produs" onKeyDown={(event) => handleTabListKeyDown(event, PRODUCT_TABS, tab, setTab)}>
                <button type="button" role="tab" id="product-tab-general" aria-controls="product-panel-general" aria-selected={tab === 'general'} tabIndex={tab === 'general' ? 0 : -1} className={tab === 'general' ? 'active' : ''} onClick={() => setTab('general')}>Date</button>
                <button type="button" role="tab" id="product-tab-images" aria-controls="product-panel-images" aria-selected={tab === 'images'} tabIndex={tab === 'images' ? 0 : -1} className={tab === 'images' ? 'active' : ''} onClick={() => setTab('images')}>Imagini <span>{form.images.length}</span></button>
                <button type="button" role="tab" id="product-tab-stock" aria-controls="product-panel-stock" aria-selected={tab === 'stock'} tabIndex={tab === 'stock' ? 0 : -1} className={tab === 'stock' ? 'active' : ''} onClick={() => setTab('stock')}>Stoc</button>
              </div>
              <div className="adm-drawer-body adm-product-form" id={`product-panel-${tab}`} role="tabpanel" aria-labelledby={`product-tab-${tab}`}>
                {tab === 'general' && (
                  <>
                    <section className="adm-form-section">
                      <h3>Identificare</h3>
                      <div className="adm-form-grid">
                        <label><span>SKU</span><input value={form.sku} onChange={(event) => set('sku', event.target.value)} required maxLength={80}/></label>
                        <label><span>Categorie</span><select value={form.categoryId} onChange={(event) => set('categoryId', event.target.value)} required>{categories.map((category) => <option key={category.id} value={category.id}>{category.name_ro}</option>)}</select></label>
                        <label className="wide"><span>Brand</span><input value={form.brand} onChange={(event) => set('brand', event.target.value)} maxLength={180}/></label>
                        {!newProduct && <label className="wide"><span>Cheie URL</span><input value={form.key} readOnly className="readonly"/></label>}
                      </div>
                    </section>
                    <section className="adm-form-section">
                      <h3>Conținut</h3>
                      <div className="adm-form-grid">
                        <label className="wide"><span>Denumire RO</span><input value={form.nameRo} onChange={(event) => set('nameRo', event.target.value)} required maxLength={300}/></label>
                        <label className="wide"><span>Denumire RU</span><input value={form.nameRu} onChange={(event) => set('nameRu', event.target.value)} maxLength={300}/></label>
                        <label className="wide"><span>Descriere RO</span><textarea value={form.descriptionRo} onChange={(event) => set('descriptionRo', event.target.value)} maxLength={20000}/></label>
                        <label className="wide"><span>Descriere RU</span><textarea value={form.descriptionRu} onChange={(event) => set('descriptionRu', event.target.value)} maxLength={20000}/></label>
                      </div>
                    </section>
                    <section className="adm-form-section">
                      <h3>Preț și praguri</h3>
                      <div className="adm-form-grid three">
                        <label><span>Preț, lei</span><input type="number" min="0" step="1" value={form.price} onChange={(event) => set('price', event.target.value)} required/></label>
                        <label><span>Preț vechi</span><input type="number" min="0" step="1" value={form.oldPrice} onChange={(event) => set('oldPrice', event.target.value)}/></label>
                        <label><span>Cost achiziție</span><input type="number" min="0" step="1" value={form.costPrice} onChange={(event) => set('costPrice', event.target.value)}/></label>
                        <label><span>Prag stoc redus</span><input type="number" min="0" step="1" value={form.lowStockThreshold} onChange={(event) => set('lowStockThreshold', event.target.value)}/></label>
                        {newProduct && <label><span>Stoc inițial</span><input type="number" min="0" step="1" value={form.initialStock} onChange={(event) => set('initialStock', event.target.value)}/></label>}
                      </div>
                    </section>
                    <section className="adm-form-section">
                      <div className="adm-section-head"><h3>Caracteristici</h3><button className="adm-compact-btn" type="button" onClick={addSpec}><Plus size={15}/>Adaugă</button></div>
                      <div className="adm-spec-list">
                        {form.specs.map((spec, index) => (
                          <div className="adm-spec-row" key={index}>
                            <input value={spec.label} onChange={(event) => updateSpec(index, 'label', event.target.value)} placeholder="Denumire" aria-label={`Denumirea specificației ${index + 1}`} maxLength={120}/>
                            <input value={spec.value} onChange={(event) => updateSpec(index, 'value', event.target.value)} placeholder="Valoare" aria-label={`Valoarea specificației ${index + 1}`} maxLength={500}/>
                            <button className="adm-icon-btn" type="button" onClick={() => removeSpec(index)} title="Elimină"><Trash2 size={16}/></button>
                          </div>
                        ))}
                        {!form.specs.length && <div className="adm-muted-empty">Nu sunt caracteristici</div>}
                      </div>
                    </section>
                    <section className="adm-form-section">
                      <h3>Vizibilitate</h3>
                      <div className="adm-check-grid">
                        {[
                          ['isActive', 'Activ'],
                          ['isNew', 'Noutate'],
                          ['isPromo', 'Promoție'],
                          ['isFeatured', 'Recomandat'],
                          ['isSummer', 'Colecție vară'],
                        ].map(([key, label]) => <label className="adm-check" key={key}><input type="checkbox" checked={form[key]} onChange={(event) => set(key, event.target.checked)}/><span>{label}</span></label>)}
                      </div>
                    </section>
                  </>
                )}

                {tab === 'images' && (
                  <section className="adm-form-section adm-images-section">
                    <div className="adm-section-head">
                      <h3><ImageIcon size={17}/>Imagini produs</h3>
                      <button className="adm-compact-btn" type="button" onClick={() => fileRef.current?.click()} disabled={uploading}>
                        {uploading ? <LoaderCircle className="adm-spin" size={15}/> : <Upload size={15}/>}Încarcă
                      </button>
                      <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/avif" hidden onChange={upload}/>
                    </div>
                    <div className="adm-image-url-row">
                      <input type="url" value={imageUrl} onChange={(event) => setImageUrl(event.target.value)} placeholder="https://..." aria-label="Adresa imaginii"/>
                      <button className="adm-icon-btn" type="button" onClick={addImageUrl} title="Adaugă URL"><Plus size={17}/></button>
                    </div>
                    <div className="adm-image-list">
                      {form.images.map((image, index) => (
                        <div className="adm-image-row" key={`${image.url}-${index}`}>
                          <div className="adm-image-preview"><img src={image.url} alt="" onError={(event) => { event.currentTarget.style.display = 'none'; }}/></div>
                          <div className="adm-image-meta"><b>{index === 0 ? 'Imagine principală' : `Imagine ${index + 1}`}</b><span>{image.url}</span></div>
                          <div className="adm-image-actions">
                            <button className="adm-icon-btn" type="button" onClick={() => moveImage(index, -1)} disabled={index === 0} title="Mută sus"><ArrowUp size={15}/></button>
                            <button className="adm-icon-btn" type="button" onClick={() => moveImage(index, 1)} disabled={index === form.images.length - 1} title="Mută jos"><ArrowDown size={15}/></button>
                            <button className="adm-icon-btn danger" type="button" onClick={() => removeImage(index)} title="Elimină"><Trash2 size={15}/></button>
                          </div>
                        </div>
                      ))}
                      {!form.images.length && <div className="adm-media-empty"><ImageIcon size={26}/>Nu sunt imagini</div>}
                    </div>
                  </section>
                )}

                {tab === 'stock' && (
                  <section className="adm-form-section adm-stock-section">
                    <h3><Boxes size={17}/>Stoc principal</h3>
                    {newProduct ? (
                      <div className="adm-stock-new"><label><span>Stoc inițial</span><input type="number" min="0" step="1" value={form.initialStock} onChange={(event) => set('initialStock', event.target.value)}/></label></div>
                    ) : (
                      <>
                        <div className="adm-stock-metrics">
                          <div><span>Fizic</span><b>{form.onHand}</b></div>
                          <div><span>Rezervat</span><b>{form.reserved}</b></div>
                          <div><span>Disponibil</span><b>{form.available}</b></div>
                        </div>
                        <div className="adm-stock-tool">
                          <select value={stockOperation} onChange={(event) => setStockOperation(event.target.value)} aria-label="Operațiune de stoc">
                            <option value="receipt">Intrare</option>
                            <option value="write_off">Casare</option>
                            <option value="return">Retur manual</option>
                            <option value="adjustment">Setare sold</option>
                          </select>
                          <input type="number" min={stockOperation === 'adjustment' ? '0' : '1'} step="1" value={stockValue} onChange={(event) => setStockValue(event.target.value)} placeholder={stockOperation === 'adjustment' ? 'Sold nou' : 'Cantitate'} aria-label={stockOperation === 'adjustment' ? 'Sold nou' : 'Cantitate'}/>
                          <input value={stockReason} onChange={(event) => setStockReason(event.target.value)} placeholder="Motiv" aria-label="Motivul modificării stocului" maxLength={500}/>
                          <button className="adm-primary" type="button" onClick={adjustStock} disabled={stockSaving || !stockValue || stockReason.trim().length < 3}>
                            {stockSaving ? <LoaderCircle className="adm-spin" size={16}/> : <PackagePlus size={16}/>}Înregistrează
                          </button>
                        </div>
                        <div className="adm-product-movements">
                          {form.movements.map((movement) => (
                            <div key={movement.id}>
                              <span className={movement.deltaOnHand > 0 ? 'plus' : movement.deltaOnHand < 0 ? 'minus' : ''}>{movement.deltaOnHand > 0 ? '+' : ''}{movement.deltaOnHand}</span>
                              <div><b>{movement.reason}</b><small>{movement.type} · {dateTime(movement.createdAt)}{movement.actor ? ` · ${movement.actor.name || movement.actor.email}` : ''}</small></div>
                              <strong>{movement.balanceOnHand}</strong>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </section>
                )}
              </div>
              {saveError && <div className="adm-editor-error" role="alert"><AlertTriangle size={16}/>{saveError}</div>}
              <footer className="adm-editor-footer">
                {closeConfirm ? (
                  <div className="adm-unsaved-confirm">
                    <AlertTriangle size={17}/><span>Modificări nesalvate</span>
                    <button type="button" onClick={() => setCloseConfirm(false)}>Rămân</button>
                    <button type="button" className="danger" onClick={() => void discardAndClose()}>Renunță</button>
                  </div>
                ) : (
                  <>
                    {!newProduct && !form.isDeleted && (
                      deleteConfirm ? (
                        <div className="adm-delete-confirm"><span>Dezactivezi produsul?</span><button type="button" onClick={() => setDeleteConfirm(false)}>Nu</button><button type="button" className="danger" onClick={deactivate}>Da</button></div>
                      ) : <button className="adm-danger-btn" type="button" onClick={() => setDeleteConfirm(true)}><Archive size={16}/>Șterge</button>
                    )}
                    {!newProduct && form.isDeleted && <button className="adm-compact-btn" type="button" onClick={() => set('isActive', true)}><RotateCcw size={16}/>Restabilește</button>}
                    <button className="adm-primary" type="submit" disabled={saving}>
                      {saving ? <LoaderCircle className="adm-spin" size={17}/> : <Save size={17}/>}Salvează
                    </button>
                  </>
                )}
              </footer>
            </>
          )}
        </form>
      </aside>
    </div>
  );
}

export default function AdminProducts({ onUnauthorized }) {
  const [categories, setCategories] = React.useState([]);
  const [products, setProducts] = React.useState([]);
  const [counts, setCounts] = React.useState({});
  const [pagination, setPagination] = React.useState({ total: 0, offset: 0, limit: PAGE_SIZE });
  const [search, setSearch] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [category, setCategory] = React.useState('');
  const [state, setState] = React.useState('all');
  const [stock, setStock] = React.useState('all');
  const [loading, setLoading] = React.useState(false);
  const [listError, setListError] = React.useState('');
  const [selectedId, setSelectedId] = React.useState('');
  const [detail, setDetail] = React.useState(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailError, setDetailError] = React.useState('');

  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  React.useEffect(() => {
    adminRequest('/api/categories').then((payload) => setCategories(payload.items)).catch((error) => {
      setListError(error.message);
      if (error instanceof AdminApiError && [401, 403].includes(error.status)) onUnauthorized();
    });
  }, [onUnauthorized]);

  const loadProducts = React.useCallback(async (nextOffset = pagination.offset) => {
    setLoading(true);
    setListError('');
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(nextOffset), state, stock });
      if (query) params.set('q', query);
      if (category) params.set('category', category);
      const payload = await adminRequest(`/api/admin/products?${params}`);
      setProducts(payload.items);
      setCounts(payload.counts);
      setPagination(payload.pagination);
    } catch (error) {
      setListError(error.message);
      if (error instanceof AdminApiError && [401, 403].includes(error.status)) onUnauthorized();
    } finally {
      setLoading(false);
    }
  }, [category, onUnauthorized, pagination.offset, query, state, stock]);
  React.useEffect(() => { loadProducts(0); }, [query, category, state, stock]); // eslint-disable-line react-hooks/exhaustive-deps

  const openProduct = React.useCallback(async (id) => {
    setSelectedId(String(id));
    setDetail(null);
    setDetailLoading(true);
    setDetailError('');
    try {
      const payload = await adminRequest(`/api/admin/products/${encodeURIComponent(id)}`);
      setDetail(payload.product);
    } catch (error) {
      setDetailError(error.message);
      if (error instanceof AdminApiError && [401, 403].includes(error.status)) onUnauthorized();
    } finally {
      setDetailLoading(false);
    }
  }, [onUnauthorized]);
  const createProduct = () => { setSelectedId('new'); setDetail(null); setDetailLoading(false); setDetailError(''); };
  const closeProduct = React.useCallback(() => { setSelectedId(''); setDetail(null); setDetailError(''); }, []);
  const rethrowWithAuth = React.useCallback((error) => {
    if (error instanceof AdminApiError && [401, 403].includes(error.status)) onUnauthorized();
    throw error;
  }, [onUnauthorized]);
  const save = async (body) => {
    try {
      const creating = selectedId === 'new';
      const payload = await adminRequest(creating ? '/api/admin/products' : `/api/admin/products/${encodeURIComponent(selectedId)}`, {
        method: creating ? 'POST' : 'PATCH',
        body,
      });
      setSelectedId(String(payload.product.id));
      setDetail(payload.product);
      await loadProducts(creating ? 0 : pagination.offset);
      return payload.product;
    } catch (error) {
      return rethrowWithAuth(error);
    }
  };
  const remove = async (revision) => {
    try {
      const payload = await adminRequest(`/api/admin/products/${encodeURIComponent(selectedId)}`, { method: 'DELETE', body: { revision } });
      setDetail(payload.product);
      await loadProducts(pagination.offset);
      return payload.product;
    } catch (error) {
      return rethrowWithAuth(error);
    }
  };
  const adjust = async (body) => {
    try {
      const payload = await adminRequest(`/api/admin/products/${encodeURIComponent(selectedId)}/inventory`, { method: 'POST', body });
      setDetail(payload.product);
      await loadProducts(pagination.offset);
      return payload.product;
    } catch (error) {
      return rethrowWithAuth(error);
    }
  };
  const upload = async (file) => {
    try {
      const form = new FormData();
      form.set('file', file);
      const payload = await adminRequest('/api/admin/uploads', { method: 'POST', body: form });
      return payload.image;
    } catch (error) {
      return rethrowWithAuth(error);
    }
  };
  const discardUpload = async (objectKey) => {
    try {
      await adminRequest(`/api/admin/uploads/${encodeURIComponent(objectKey)}`, { method: 'DELETE', body: {} });
    } catch (error) {
      return rethrowWithAuth(error);
    }
  };

  const resetFilters = () => { setSearch(''); setCategory(''); setState('all'); setStock('all'); };
  const totalPages = Math.max(1, Math.ceil(pagination.total / PAGE_SIZE));
  const currentPage = Math.floor(pagination.offset / PAGE_SIZE) + 1;
  return (
    <>
      <header className="adm-topbar adm-products-topbar">
        <div><span>Catalog</span><h1>Produse</h1></div>
        <div>
          <button className="adm-icon-btn" type="button" onClick={() => loadProducts(pagination.offset)} title="Actualizează"><RefreshCw className={loading ? 'adm-spin' : ''} size={19}/></button>
          <button className="adm-primary" type="button" onClick={createProduct}><Plus size={18}/>Produs nou</button>
        </div>
      </header>

      <section className="adm-summary adm-product-summary" aria-label="Sumar produse">
        <button type="button" className={state === 'active' && stock === 'all' ? 'active' : ''} onClick={() => { setState('active'); setStock('all'); }}><span>Active</span><b>{counts.active || 0}</b></button>
        <button type="button" className={stock === 'low' ? 'active' : ''} onClick={() => { setState('active'); setStock('low'); }}><span>Stoc redus</span><b>{counts.lowStock || 0}</b></button>
        <button type="button" className={stock === 'out' ? 'active' : ''} onClick={() => { setState('active'); setStock('out'); }}><span>Fără stoc</span><b>{counts.outOfStock || 0}</b></button>
        <button type="button" className={state === 'inactive' ? 'active' : ''} onClick={() => { setState('inactive'); setStock('all'); }}><span>Inactive</span><b>{counts.inactive || 0}</b></button>
      </section>

      <section className="adm-orders-panel adm-products-panel">
        <div className="adm-toolbar adm-product-toolbar">
          <div className="adm-search"><Search size={18}/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Denumire, SKU, brand" aria-label="Caută produse"/></div>
          <select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Filtru categorie"><option value="">Toate categoriile</option>{categories.map((item) => <option key={item.id} value={item.id}>{item.name_ro}</option>)}</select>
          <select value={state} onChange={(event) => setState(event.target.value)} aria-label="Filtru stare"><option value="all">Toate stările</option><option value="active">Active</option><option value="inactive">Inactive</option></select>
          <select value={stock} onChange={(event) => setStock(event.target.value)} aria-label="Filtru stoc"><option value="all">Orice stoc</option><option value="low">Stoc redus</option><option value="out">Fără stoc</option></select>
          {(query || category || state !== 'all' || stock !== 'all') && <button className="adm-clear" type="button" onClick={resetFilters}>Resetează</button>}
        </div>
        {listError && <div className="adm-list-message adm-error"><AlertTriangle size={18}/>{listError}</div>}
        {!listError && !loading && products.length === 0 && <div className="adm-list-message"><Boxes size={24}/>Nu sunt produse</div>}
        <div className="adm-table-wrap">
          <table className="adm-table adm-products-table">
            <thead><tr><th>Produs</th><th>Categorie</th><th>Preț</th><th>Stoc fizic</th><th>Rezervat</th><th>Stare</th><th>Actualizat</th><th aria-label="Acțiune"/></tr></thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.id} onClick={() => openProduct(product.id)}>
                  <td><div className="adm-product-cell"><div className="adm-product-thumb">{product.image ? <img src={product.image} alt=""/> : <ImageIcon size={18}/>}</div><div><b>{product.name}</b><span>{product.sku || product.key} · {product.brand}</span></div></div></td>
                  <td>{product.categoryName}</td>
                  <td><strong>{money(product.price)}</strong>{product.oldPrice > product.price && <span>{money(product.oldPrice)}</span>}</td>
                  <td><strong>{product.onHand}</strong><span>Disponibil {product.available}</span></td>
                  <td>{product.reserved}</td>
                  <td><ProductState product={product}/></td>
                  <td>{dateTime(product.updatedAt)}</td>
                  <td><button className="adm-row-open" type="button" title="Deschide" onClick={(event) => { event.stopPropagation(); openProduct(product.id); }}><ChevronRight size={18}/></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <div className="adm-table-loading"><LoaderCircle className="adm-spin" size={24}/></div>}
        </div>
        <footer className="adm-pagination">
          <span>{pagination.total} produse · pagina {currentPage} din {totalPages}</span>
          <div>
            <button className="adm-icon-btn" type="button" title="Pagina precedentă" disabled={pagination.offset === 0 || loading} onClick={() => loadProducts(Math.max(0, pagination.offset - PAGE_SIZE))}><ArrowLeft size={18}/></button>
            <button className="adm-icon-btn" type="button" title="Pagina următoare" disabled={pagination.offset + PAGE_SIZE >= pagination.total || loading} onClick={() => loadProducts(pagination.offset + PAGE_SIZE)}><ArrowRight size={18}/></button>
          </div>
        </footer>
      </section>

      {selectedId && <ProductEditor key={selectedId} product={detail} categories={categories} loading={detailLoading} error={detailError} onClose={closeProduct} onSave={save} onDelete={remove} onAdjust={adjust} onUpload={upload} onDiscardUpload={discardUpload}/>}
    </>
  );
}
