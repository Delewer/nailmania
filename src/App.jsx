/* ===== App ===== */
import React from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { ShopProvider } from './shop.jsx'
import { Header } from './components/Header.jsx'
import { Footer } from './components/Content.jsx'
import { Overlays } from './components/Menus.jsx'
import Home from './pages/Home.jsx'
import CategoryPage from './pages/CategoryPage.jsx'
import BrandPage from './pages/BrandPage.jsx'
import ProductPage from './pages/ProductPage.jsx'
import Checkout from './pages/Checkout.jsx'

export default function App(){
  return (
    <BrowserRouter>
      <ShopProvider>
        <Header/>
        <main>
          <Routes>
            <Route path="/" element={<Home/>}/>
            <Route path="/category/:id" element={<CategoryPage/>}/>
            <Route path="/brand/:name" element={<BrandPage/>}/>
            <Route path="/product/:id" element={<ProductPage/>}/>
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
