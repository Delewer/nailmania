/* ===== Category page: products of one section + brand filter ===== */
import React from 'react'
import { useParams, useSearchParams, Link } from 'react-router-dom'
import { useShop, Icon } from '../shop.jsx'
import { ProductCard } from '../components/Products.jsx'
import { findCategory, productsByCat, brandsByCat, inStock } from '../data.js'

const PER_PAGE = 12;

export default function CategoryPage(){
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const { t, name } = useShop();
  const cat = findCategory(id);

  const products = React.useMemo(()=>productsByCat(id), [id]);
  const brands   = React.useMemo(()=>brandsByCat(id), [id]);

  // selected brand lives in the URL (?brand=…) so it survives refresh/share/back
  const rawBrand = params.get("brand");
  const brand = brands.some(b=>b.brand===rawBrand) ? rawBrand : null;
  const setBrand = (b)=> setParams(b ? {brand:b} : {}, {replace:false});
  const [page, setPage] = React.useState(0);

  React.useEffect(()=>{ window.scrollTo({top:0}); }, [id]);
  React.useEffect(()=>{ setPage(0); }, [id, brand]);

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

  const matched = brand ? products.filter(p=>p.brand===brand) : products;
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
          <button
            className={"brandchip"+(brand===null?" on":"")}
            onClick={()=>setBrand(null)}>
            {t("allBrands")} <span className="cnt">{products.length}</span>
          </button>
          {brands.map(({brand:b,count})=>(
            <button
              key={b}
              className={"brandchip"+(brand===b?" on":"")}
              onClick={()=>setBrand(b)}>
              {b} <span className="cnt">{count}</span>
            </button>
          ))}
        </div>
      )}

      {slice.length===0 ? (
        <div className="page-empty"><Icon n="search" s={56}/><p>{t("noResults")}</p></div>
      ) : (
        <div className="prod-grid">
          {slice.map(p=><ProductCard key={p.key} p={p}/>)}
        </div>
      )}

      {pages>1 && (
        <div className="pager">
          {Array.from({length:pages}).map((_,i)=>(
            <button key={i} className={i===page?"on":""} onClick={()=>{setPage(i); window.scrollTo({top:0,behavior:"smooth"});}} aria-label={"page "+(i+1)}/>
          ))}
        </div>
      )}
    </div>
  );
}
