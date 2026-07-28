/* ===== App ===== */
import React from 'react'
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { AuthProvider } from './auth.jsx'
import { ShopProvider } from './shop.jsx'
import { Header } from './components/Header.jsx'
import { Footer, About, Payment, Contacts, NotFound } from './components/Content.jsx'
import { Overlays } from './components/Menus.jsx'
import { Seo } from './components/Seo.jsx'

const Home = React.lazy(()=>import('./pages/Home.jsx'));
const CategoryPage = React.lazy(()=>import('./pages/CategoryPage.jsx'));
const BrandPage = React.lazy(()=>import('./pages/BrandPage.jsx'));
const ProductPage = React.lazy(()=>import('./pages/ProductPage.jsx'));
const Checkout = React.lazy(()=>import('./pages/Checkout.jsx'));
const SearchPage = React.lazy(()=>import('./pages/SearchPage.jsx'));
const AdminOrders = React.lazy(()=>import('./pages/AdminOrders.jsx'));
const AuthPages = React.lazy(()=>import('./pages/AuthPages.jsx'));
const AccountPage = React.lazy(()=>import('./pages/AccountPage.jsx'));
const AccountOrderPage = React.lazy(()=>import('./pages/AccountOrderPage.jsx'));

// scroll to top when navigating to a new path (keep anchor scroll when a #hash is present)
function ScrollTop(){
  const { pathname, hash } = useLocation();
  React.useEffect(()=>{
    if(!hash){
      window.scrollTo(0,0);
      return undefined;
    }
    const id = decodeURIComponent(hash.slice(1));
    const scrollToAnchor = ()=>document.getElementById(id)?.scrollIntoView({block:"start"});
    const frame = window.requestAnimationFrame(scrollToAnchor);
    const retry = window.setTimeout(scrollToAnchor, 120);
    return ()=>{
      window.cancelAnimationFrame(frame);
      window.clearTimeout(retry);
    };
  }, [pathname, hash]);
  return null;
}

function PageFallback(){
  return <div className="wrap page"><div className="page-empty"/></div>;
}

function Storefront(){
  return (
    <AuthProvider>
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
              <Route path="/search" element={<SearchPage/>}/>
              <Route path="/product/:id" element={<ProductPage/>}/>
              <Route path="/livrare" element={<About/>}/>
              <Route path="/plata" element={<Payment/>}/>
              <Route path="/contacte" element={<Contacts/>}/>
              <Route path="/checkout" element={<Checkout/>}/>
              <Route path="/login" element={<AuthPages mode="login"/>}/>
              <Route path="/register" element={<AuthPages mode="register"/>}/>
              <Route path="/forgot-password" element={<AuthPages mode="forgot"/>}/>
              <Route path="/reset-password" element={<AuthPages mode="reset"/>}/>
              <Route path="/logout" element={<AuthPages mode="logout"/>}/>
              <Route path="/account" element={<AccountPage/>}/>
              <Route path="/account/orders/:id" element={<AccountOrderPage/>}/>
              <Route path="*" element={<NotFound/>}/>
            </Routes>
          </React.Suspense>
        </main>
        <Footer/>
        <Overlays/>
      </ShopProvider>
    </AuthProvider>
  );
}

function AppRoutes(){
  const { pathname } = useLocation();
  if(pathname.startsWith('/admin')){
    return <React.Suspense fallback={<div className="adm-boot"/>}><Routes><Route path="/admin/*" element={<AdminOrders/>}/></Routes></React.Suspense>;
  }
  return <Storefront/>;
}

export default function App(){
  return <BrowserRouter><AppRoutes/></BrowserRouter>;
}
