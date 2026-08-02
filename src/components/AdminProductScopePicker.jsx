import React from 'react';
import { AlertTriangle, LoaderCircle, Plus, Search, X } from 'lucide-react';
import { AdminApiError, adminRequest } from '../admin-api.js';

const productLabel = (product) => product.nameRo || product.name || product.sku || product.key || product.id;

export default function AdminProductScopePicker({
  selected,
  onChange,
  label = 'promoție',
  onUnauthorized,
  disabled = false,
}) {
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const searchSequence = React.useRef(0);
  const search = async () => {
    const term = query.trim();
    if (term.length < 2 || loading || disabled) return;
    const sequence = ++searchSequence.current;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ q: term, limit: '20', state: 'active', stock: 'all' });
      const payload = await adminRequest(`/api/admin/products?${params}`);
      if (sequence !== searchSequence.current) return;
      const chosen = new Set(selected.map((item) => Number(item.id)));
      setResults(payload.items.filter((item) => !chosen.has(Number(item.id))));
    } catch (caught) {
      if (caught instanceof AdminApiError && [401, 403].includes(caught.status)) onUnauthorized?.();
      if (sequence === searchSequence.current) setError(caught.message);
    } finally {
      if (sequence === searchSequence.current) setLoading(false);
    }
  };
  const add = (product) => {
    if (disabled || selected.some((item) => Number(item.id) === Number(product.id))) return;
    onChange([...selected, {
      id: Number(product.id),
      key: product.key,
      sku: product.sku,
      nameRo: product.name,
      brand: product.brand,
    }]);
    setResults((items) => items.filter((item) => Number(item.id) !== Number(product.id)));
  };
  const chosen = new Set(selected.map((item) => Number(item.id)));
  const availableResults = results.filter((item) => !chosen.has(Number(item.id)));
  return (
    <div className="adm-promo-product-picker">
      <div className="adm-promo-scope-selected">
        {selected.map((product) => (
          <span key={product.id}>{productLabel(product)}
            <button type="button" disabled={disabled} onClick={() => onChange(selected.filter((item) => Number(item.id) !== Number(product.id)))} aria-label={`Elimină produsul ${productLabel(product)}`}><X size={13}/></button>
          </span>
        ))}
        {!selected.length && <small>Nu sunt produse selectate</small>}
      </div>
      <div className="adm-promo-product-search">
        <input
          value={query}
          onChange={(event) => {
            searchSequence.current += 1;
            setQuery(event.target.value);
            setResults([]);
            setError('');
            setLoading(false);
          }}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); search(); } }}
          placeholder="Caută după nume, SKU sau brand"
          aria-label={`Caută produse pentru ${label}`}
          disabled={disabled}
        />
        <button className="adm-compact-btn" type="button" onClick={search} disabled={disabled || query.trim().length < 2 || loading}>
          {loading ? <LoaderCircle className="adm-spin" size={15}/> : <Search size={15}/>}Caută
        </button>
      </div>
      {error && <div className="adm-inline-error" role="alert"><AlertTriangle size={14}/>{error}</div>}
      {availableResults.length > 0 && <div className="adm-promo-search-results">
        {availableResults.map((product) => <button type="button" disabled={disabled} key={product.id} onClick={() => add(product)}><span><b>{product.name}</b><small>{product.sku || product.key} · {product.categoryName} · {product.brand}</small></span><Plus size={15}/></button>)}
      </div>}
    </div>
  );
}
