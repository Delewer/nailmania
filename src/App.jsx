/* ===== App ===== */
import React from 'react'
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { ShopProvider } from './shop.jsx'
import { Header } from './components/Header.jsx'
import { Footer, About, Payment, Contacts } from './components/Content.jsx'
import { Overlays } from './components/Menus.jsx'
import Home from './pages/Home.jsx'
import CategoryPage from './pages/CategoryPage.jsx'
import BrandPage from './pages/BrandPage.jsx'
import ProductPage from './pages/ProductPage.jsx'
import Checkout from './pages/Checkout.jsx'

// scroll to top when navigating to a new path (keep anchor scroll when a #hash is present)
function ScrollTop(){
  const { pathname, hash } = useLocation();
  React.useEffect(()=>{ if(!hash) window.scrollTo(0,0); }, [pathname, hash]);
  return null;
}

export default function App(){
  return (
    <BrowserRouter>
      <ShopProvider>
        <ScrollTop/>
        <Header/>
        <main>
          <Routes>
            <Route path="/" element={<Home/>}/>
            <Route path="/category/:id" element={<CategoryPage/>}/>
            <Route path="/brand/:name" element={<BrandPage/>}/>
            <Route path="/product/:id" element={<ProductPage/>}/>
            <Route path="/livrare" element={<About/>}/>
            <Route path="/plata" element={<Payment/>}/>
            <Route path="/contacte" element={<Contacts/>}/>
            <Route path="/checkout" element={<Checkout/>}/>
            <Route path="*" element={<Home/>}/>
          </Routes>
        </main>
        <Footer/>
        <Overlays/>
      </ShopProvider>
    </BrowserRouter>
  );
}
