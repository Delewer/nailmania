/* ===== Home (storefront landing) ===== */
import React from 'react'
import { useLocation } from 'react-router-dom'
import { Hero, Categories } from '../components/Hero.jsx'
import { ProductSection } from '../components/Products.jsx'
import { Brands, Social } from '../components/Content.jsx'

export default function Home(){
  const { hash } = useLocation();
  const [sections, setSections] = React.useState(null);

  React.useEffect(()=>{
    let alive = true;
    import('../catalog-data.js').then(({ featured, SALE_PRODUCTS, SUMMER_PRODUCTS, NEW_PRODUCTS })=>{
      if(!alive) return;
      setSections({
        best: featured(1, 8),
        newItems: NEW_PRODUCTS.length ? NEW_PRODUCTS : featured(7, 8),
        sale: SALE_PRODUCTS,
        summer: SUMMER_PRODUCTS,
      });
    });
    return ()=>{ alive = false; };
  },[]);

  // scroll to in-page anchor when arriving from another route (e.g. footer links)
  React.useEffect(()=>{
    if(!hash) return;
    const el = document.querySelector(hash);
    if(el) setTimeout(()=>window.scrollTo({top:el.getBoundingClientRect().top+window.scrollY-90,behavior:"smooth"}), 60);
  },[hash]);

  return (
    <>
      <Hero/>
      <Categories/>
      {sections && (
        <>
          {sections.summer.length>0 && <ProductSection id="summer" titleKey="secSummer" items={sections.summer} perPage={8}/>}
          <ProductSection id="best" titleKey="secBest" items={sections.best} perPage={8}/>
          <ProductSection id="new" titleKey="secNew" items={sections.newItems} perPage={8}/>
          {sections.sale.length>0 && <ProductSection id="sale" titleKey="secSale" items={sections.sale} perPage={8}/>}
        </>
      )}
      <Brands/>
      <Social/>
    </>
  );
}
