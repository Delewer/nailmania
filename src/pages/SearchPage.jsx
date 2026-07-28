import React from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useShop, Icon } from '../shop.jsx'
import { ProductCard, Pager } from '../components/Products.jsx'
import { ALL_PRODUCTS, CATALOG_ERROR } from '../catalog-data.js'
import { searchProducts } from '../search.js'
import { CatalogUnavailable } from '../components/CatalogState.jsx'
import { trackProductEvent } from '../product-analytics.js'

const PER_PAGE = 24;

export default function SearchPage(){
  const [params] = useSearchParams();
  const q = params.get("q") || "";
  const { t, lang } = useShop();
  const [page,setPage] = React.useState(0);
  const results = React.useMemo(()=>searchProducts(ALL_PRODUCTS, q), [q]);
  const pages = Math.ceil(results.length / PER_PAGE);
  const slice = results.slice(page*PER_PAGE, (page+1)*PER_PAGE);

  React.useEffect(()=>{ setPage(0); }, [q]);
  React.useEffect(()=>{
    if(q.trim()) trackProductEvent('search',{
      language:lang,source:'search',resultCount:results.length,queryLength:q.length,
    });
  },[q,results.length,lang]);

  if(CATALOG_ERROR) return <div className="wrap page"><CatalogUnavailable/></div>;

  return (
    <div className="wrap page cat-page search-page">
      <nav className="crumbs">
        <Link to="/">{t("home")}</Link>
        <Icon n="chev" s={14}/>
        <span className="cur">{t("search")}</span>
      </nav>

      <header className="cat-head">
        <h1>{q ? `${t("search")}: ${q}` : t("search")}</h1>
        <span className="cat-count">{results.length} {t("results")}</span>
      </header>

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
