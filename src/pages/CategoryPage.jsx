/* ===== Category page: products of one section + brand & characteristic filters ===== */
import React from 'react'
import { useParams, useSearchParams, Link } from 'react-router-dom'
import { useShop, Icon } from '../shop.jsx'
import { ProductCard, Pager } from '../components/Products.jsx'
import { findCategory } from '../data.js'
import { productsByCat, brandsByCat, facetsByCat, specLabel, specValue, inStock } from '../catalog-data.js'

const PER_PAGE = 12;
const keyOf = (label)=> label.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');

export default function CategoryPage(){
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const { t, name, lang } = useShop();
  const cat = findCategory(id);

  const products = React.useMemo(()=>productsByCat(id), [id]);
  const brands   = React.useMemo(()=>brandsByCat(id), [id]);
  const facets   = React.useMemo(()=>facetsByCat(id), [id]);

  // brand + selected spec values live in the URL (?brand=…&putere=65 W|120 W) so
  // they survive refresh / share / back navigation
  const rawBrand = params.get("brand");
  const brand = brands.some(b=>b.brand===rawBrand) ? rawBrand : null;
  const selected = {};
  for(const f of facets){ const raw = params.get(keyOf(f.label)); if(raw) selected[f.label] = new Set(raw.split('|')); }
  const activeCount = (brand?1:0) + Object.keys(selected).length;

  const [page, setPage] = React.useState(0);
  React.useEffect(()=>{ window.scrollTo({top:0}); }, [id]);
  React.useEffect(()=>{ setPage(0); }, [id, params.toString()]);

  const setBrand = (b)=>{ const n=new URLSearchParams(params); b?n.set("brand",b):n.delete("brand"); setParams(n); };
  const toggleFacet = (label,value)=>{
    const k=keyOf(label); const cur=new Set((params.get(k)||"").split('|').filter(Boolean));
    cur.has(value)?cur.delete(value):cur.add(value);
    const n=new URLSearchParams(params); cur.size?n.set(k,[...cur].join('|')):n.delete(k); setParams(n);
  };
  const clearAll = ()=> setParams(new URLSearchParams());

  if(!cat){
    return (
      <div className="wrap page">
        <div className="page-empty">
          <Icon n="search" s={60}/>
          <h2>{t("noResults")}</h2>
          <Link className="btn btn-dark" to="/">{t("backHome")}</Link>
        </div>
      </div>
    );
  }

  let matched = brand ? products.filter(p=>p.brand===brand) : products;
  for(const f of facets){
    const sel = selected[f.label]; if(!sel || !sel.size) continue;       // AND across facets, OR within
    matched = matched.filter(p => (p.specs||[]).some(s=> s.label===f.label && sel.has(s.value)));
  }
  const filtered = [...matched].sort((a,b)=> Number(inStock(b)) - Number(inStock(a))); // in-stock first
  const pages = Math.ceil(filtered.length / PER_PAGE);
  const slice = filtered.slice(page*PER_PAGE, (page+1)*PER_PAGE);

  return (
    <div className="wrap page cat-page">
      <nav className="crumbs">
        <Link to="/">{t("home")}</Link>
        <Icon n="chev" s={14}/>
        <span className="cur">{name(cat)}</span>
      </nav>

      <header className="cat-head">
        <h1>{name(cat)}</h1>
        <span className="cat-count">{filtered.length} {t("results")}</span>
      </header>

      {/* brand filter — only brands present in this section */}
      {brands.length>1 && (
        <div className="brandbar" role="tablist" aria-label={t("filterBrand")}>
          <button className={"brandchip"+(brand===null?" on":"")} onClick={()=>setBrand(null)}>
            {t("allBrands")} <span className="cnt">{products.length}</span>
          </button>
          {brands.map(({brand:b,count})=>(
            <button key={b} className={"brandchip"+(brand===b?" on":"")} onClick={()=>setBrand(b)}>
              {b} <span className="cnt">{count}</span>
            </button>
          ))}
        </div>
      )}

      {/* characteristic filters — auto-shown only where the data has them */}
      {facets.map(f=>(
        <div className="facet" key={f.label}>
          <span className="facet-lbl">{specLabel(f.label, lang)}</span>
          <div className="facet-chips">
            {f.values.map(v=>(
              <button key={v.value}
                className={"fchip"+(selected[f.label]?.has(v.value)?" on":"")}
                onClick={()=>toggleFacet(f.label, v.value)}>
                {specValue(v.value, lang)} <span className="cnt">{v.count}</span>
              </button>
            ))}
          </div>
        </div>
      ))}

      {activeCount>0 && (
        <button className="filter-clear" onClick={clearAll}><Icon n="close" s={15}/>{t("clear")}</button>
      )}

      {slice.length===0 ? (
        <div className="page-empty"><Icon n="search" s={56}/><p>{t("noResults")}</p></div>
      ) : (
        <div className="prod-grid">
          {slice.map(p=><ProductCard key={p.key} p={p}/>)}
        </div>
      )}

      <Pager page={page} pages={pages} onSelect={(i)=>{setPage(i); window.scrollTo({top:0,behavior:"smooth"});}}/>
    </div>
  );
}
