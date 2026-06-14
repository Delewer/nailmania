/* ===== Home (storefront landing) ===== */
import React from 'react'
import { useLocation } from 'react-router-dom'
import { Hero, Categories } from '../components/Hero.jsx'
import { ProductSection } from '../components/Products.jsx'
import { Brands, About, Social } from '../components/Content.jsx'
import { featured, SALE_PRODUCTS, SUMMER_PRODUCTS } from '../data.js'

// real-catalog rows (stable, varied picks — see featured() in data.js)
const BEST = featured(1, 8);
const NEW  = featured(7, 8);

export default function Home(){
  const { hash } = useLocation();
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
      {SUMMER_PRODUCTS.length>0 && <ProductSection id="summer" titleKey="secSummer" items={SUMMER_PRODUCTS} perPage={8}/>}
      <ProductSection id="best" titleKey="secBest" items={BEST} perPage={8}/>
      <ProductSection id="new" titleKey="secNew" items={NEW} perPage={8}/>
      {SALE_PRODUCTS.length>0 && <ProductSection id="sale" titleKey="secSale" items={SALE_PRODUCTS} perPage={8}/>}
      <Brands/>
      <About/>
      <Social/>
    </>
  );
}
