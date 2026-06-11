/* ===== Brand page: products of one brand + category filter ===== */
import React from 'react'
import { useParams, useSearchParams, Link } from 'react-router-dom'
import { useShop, Icon } from '../shop.jsx'
import { ProductCard, Pager } from '../components/Products.jsx'
import { findCategory, productsByBrand, catsByBrand, inStock } from '../data.js'

const PER_PAGE = 12;

export default function BrandPage(){
  const { name: brandParam } = useParams();
  const brand = decodeURIComponent(brandParam || "");
  const [params, setParams] = useSearchParams();
  const { t, name } = useShop();

  const products = React.useMemo(()=>productsByBrand(brand), [brand]);
  const cats     = React.useMemo(()=>catsByBrand(brand), [brand]);

  // selected category lives in the URL (?cat=…)
  const rawCat = params.get("cat");
  const cat = cats.some(c=>c.cat===rawCat) ? rawCat : null;
  const setCat = (c)=> setParams(c ? {cat:c} : {}, {replace:false});
  const [page, setPage] = React.useState(0);

  React.useEffect(()=>{ window.scrollTo({top:0}); }, [brand]);
  React.useEffect(()=>{ setPage(0); }, [brand, cat]);

  if(!products.length){
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

  const matched = cat ? products.filter(p=>p.cat===cat) : products;
  const filtered = [...matched].sort((a,b)=> Number(inStock(b)) - Number(inStock(a))); // in-stock first
  const pages = Math.ceil(filtered.length / PER_PAGE);
  const slice = filtered.slice(page*PER_PAGE, (page+1)*PER_PAGE);

  return (
    <div className="wrap page cat-page">
      <nav className="crumbs">
        <Link to="/">{t("home")}</Link>
        <Icon n="chev" s={14}/>
        <span className="cur">{brand}</span>
      </nav>

      <header className="cat-head">
        <h1>{brand}</h1>
        <span className="cat-count">{filtered.length} {t("results")}</span>
      </header>

      {/* category filter — only categories this brand appears in */}
      {cats.length>1 && (
        <div className="brandbar" aria-label={t("filterCat")}>
          <button className={"brandchip"+(cat===null?" on":"")} onClick={()=>setCat(null)}>
            {t("allCats")} <span className="cnt">{products.length}</span>
          </button>
          {cats.map(({cat:cid,count})=>{
            const c = findCategory(cid);
            return (
              <button key={cid} className={"brandchip"+(cat===cid?" on":"")} onClick={()=>setCat(cid)}>
                {c ? name(c) : cid} <span className="cnt">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="prod-grid">
        {slice.map(p=><ProductCard key={p.key} p={p}/>)}
      </div>

      <Pager page={page} pages={pages} onSelect={(i)=>{setPage(i); window.scrollTo({top:0,behavior:"smooth"});}}/>
    </div>
  );
}
