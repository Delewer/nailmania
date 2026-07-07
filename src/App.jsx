/* ===== App ===== */
import React from 'react'
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { ShopProvider } from './shop.jsx'
import { Header } from './components/Header.jsx'
import { Footer, About, Payment, Contacts } from './components/Content.jsx'
import { Overlays } from './components/Menus.jsx'
import { Seo } from './components/Seo.jsx'

const Home = React.lazy(()=>import('./pages/Home.jsx'));
const CategoryPage = React.lazy(()=>import('./pages/CategoryPage.jsx'));
const BrandPage = React.lazy(()=>import('./pages/BrandPage.jsx'));
const ProductPage = React.lazy(()=>import('./pages/ProductPage.jsx'));
const Checkout = React.lazy(()=>import('./pages/Checkout.jsx'));

// scroll to top when navigating to a new path (keep anchor scroll when a #hash is present)
function ScrollTop(){
  const { pathname, hash } = useLocation();
  React.useEffect(()=>{ if(!hash) window.scrollTo(0,0); }, [pathname, hash]);
  return null;
}

function PageFallback(){
  return <div className="wrap page"><div className="page-empty"/></div>;
}

export default function App(){
  return (
    <BrowserRouter>
      <ShopProvider>
        <ScrollTop/>
        <Seo/>
        <Header/>
        <main>
          <React.Suspense fallback={<PageFallback/>}>
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
          </React.Suspense>
        </main>
        <Footer/>
        <Overlays/>
      </ShopProvider>
    </BrowserRouter>
  );
}
