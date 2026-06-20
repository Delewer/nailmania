/* ===== Shop store: context, state, icons, placeholders ===== */
import React from 'react'
import { I18N } from './data.js'

let catalogPromise = null;
const loadCatalogProducts = ()=> {
  catalogPromise ||= import('./catalog-data.js').then(m=>m.ALL_PRODUCTS);
  return catalogPromise;
};

// ---------- Icons (UI only) ----------
const I = {
  search:  "M11 4a7 7 0 1 0 4.9 12l4.3 4.3 1.4-1.4-4.3-4.3A7 7 0 0 0 11 4Zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z",
  heart:   "M12 21s-7.5-4.6-10-9.3C.4 8.4 2 5 5.4 5c2 0 3.4 1.1 4.6 2.7C11.2 6.1 12.6 5 14.6 5 18 5 19.6 8.4 22 11.7 19.5 16.4 12 21 12 21Z",
  bag:     "M6 7V6a6 6 0 0 1 12 0v1h3l1 14H2L3 7h3Zm2 0h8V6a4 4 0 0 0-8 0v1Z",
  menu:    "M3 6h18M3 12h18M3 18h18",
  close:   "M6 6l12 12M18 6 6 18",
  truck:   "M3 6h11v9H3zM14 9h4l3 3v3h-7zM7 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm11 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  plus:    "M12 5v14M5 12h14",
  minus:   "M5 12h14",
  chev:    "M9 6l6 6-6 6",
  chevD:   "M6 9l6 6 6-6",
  arrow:   "M5 12h14M13 6l6 6-6 6",
  trash:   "M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0-1 13H7L6 7",
  sliders: "M4 7h11M19 7h1M4 17h1M9 17h11M14 4v6M9 14v6",
  star:    "M12 3l2.6 5.6 6 .7-4.4 4.1 1.2 6-5.4-3-5.4 3 1.2-6L3.4 9.3l6-.7Z",
  spark:   "M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6z",
  ig:      "M12 8.8A3.2 3.2 0 1 0 12 15.2 3.2 3.2 0 0 0 12 8.8Zm5-1.1a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z",
  tg:      "M21 5 2.6 12.1c-.9.3-.9 1.5 0 1.8l4.6 1.4 1.7 5c.3.8 1.3 1 1.9.3l2.5-2.6 4.6 3.4c.7.5 1.7.1 1.9-.8L23 6c.2-1-.8-1.7-2-.9Z",
  wa:      "M12 3a9 9 0 0 0-7.7 13.6L3 21l4.5-1.2A9 9 0 1 0 12 3Zm5 12.6c-.2.6-1.2 1.1-1.7 1.1-.4 0-1 .1-3.2-.9-2.7-1.2-4.3-4-4.5-4.2-.1-.2-1-1.3-1-2.5s.6-1.8.9-2c.2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 1.9c.1.2.1.4 0 .6l-.4.5c-.2.2-.3.4-.1.7.2.3.9 1.4 1.9 2.2 1.3 1 1.8 1 2.1.9l.6-.7c.2-.3.4-.2.7-.1l1.8.9c.3.1.4.2.5.3.1.3.1.7-.1 1.3Z",
  fb:      "M14 9h2.5l.5-3H14V4.5c0-.9.3-1.5 1.6-1.5H17V.3C16.7.2 15.8 0 14.8 0 12.6 0 11 1.4 11 3.9V6H8.5v3H11v9h3V9Z",
  pin:     "M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5Z",
  mail:    "M3 5h18v14H3zM3 6l9 7 9-7",
  phone:   "M4 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L18 14l5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 2 6a2 2 0 0 1 2-2Z",
  check:   "M5 12l5 5L20 7",
  card:    "M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zM2 10h20M6 15h4",
  cash:    "M2 7a1 1 0 0 1 1-1h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM5 9v.01M19 14.99V15",
  store:   "M4 9l1.2-4.2A1 1 0 0 1 6.2 4h11.6a1 1 0 0 1 1 .8L20 9M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9M4 9h16M9 20v-6h6v6"
};
export function Icon({n, s=22, sw=2, fill=false, style}){
  const filled = ["heart","bag","ig","tg","wa","fb","star","spark","pin","check"].includes(n) && fill;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill={filled?"currentColor":"none"}
      stroke={filled?"none":"currentColor"} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden="true">
      <path d={I[n]} />
    </svg>
  );
}

// ---------- Product/category placeholder image ----------
// When `img` is provided it renders a real photo on top of the gradient; if the
// photo fails to load it hides itself, revealing the gradient + icon fallback —
// so a broken URL never shows a broken image.
export function Placeholder({g, icon, label, ratio="1", radius=14, img}){
  const [failed, setFailed] = React.useState(false);
  const grad = g && g.length>1
    ? `linear-gradient(150deg, ${g[0]} 0%, ${g[1]} 100%)`
    : `linear-gradient(150deg, var(--peach), var(--blush-2))`;
  return (
    <div className="ph" style={{aspectRatio:ratio, borderRadius:radius, background:grad}}>
      {icon && <PhShape kind={icon}/>}
      {img && !failed && (
        <img className="ph-img" src={img} alt={label||""} loading="lazy" onError={()=>setFailed(true)}/>
      )}
      <span className="ph-grain" />
    </div>
  );
}
// abstract "product" silhouette so placeholders read as photos, not empty boxes
export function PhShape({kind}){
  const c = "rgba(255,255,255,.55)", d="rgba(40,20,30,.10)";
  const wrap = {position:"absolute",inset:0,display:"grid",placeItems:"center"};
  if(kind==="bottle") return <div style={wrap}><svg width="40%" viewBox="0 0 60 120"><rect x="22" y="2" width="16" height="14" rx="3" fill={d}/><rect x="18" y="16" width="24" height="10" rx="2" fill={c}/><rect x="14" y="26" width="32" height="86" rx="10" fill={c}/><rect x="14" y="74" width="32" height="38" rx="10" fill={d}/></svg></div>;
  if(kind==="tip") return <div style={wrap}><svg width="42%" viewBox="0 0 80 80"><path d="M30 6c8-4 18-4 24 4s2 30-14 60c-16-30-22-52-16-60 2-3 4-4 6-4Z" fill={c}/></svg></div>;
  if(kind==="bit") return <div style={wrap}><svg width="34%" viewBox="0 0 60 120"><rect x="25" y="6" width="10" height="58" rx="5" fill={c}/><path d="M30 60c15 8 16 32 0 52-16-20-15-44 0-52Z" fill={d}/></svg></div>;
  if(kind==="tool") return <div style={wrap}><svg width="50%" viewBox="0 0 96 96"><circle cx="26" cy="68" r="12" fill="none" stroke={c} strokeWidth="6"/><circle cx="54" cy="68" r="12" fill="none" stroke={c} strokeWidth="6"/><path d="M33 61 84 16" fill="none" stroke={c} strokeWidth="6" strokeLinecap="round"/><path d="M47 61 84 30" fill="none" stroke={c} strokeWidth="6" strokeLinecap="round"/><circle cx="44" cy="55" r="3" fill={d}/></svg></div>;
  if(kind==="lamp") return <div style={wrap}><svg width="46%" viewBox="0 0 100 70"><path d="M8 50a42 42 0 0 1 84 0v8H8z" fill={c}/><rect x="8" y="50" width="84" height="10" rx="4" fill={d}/></svg></div>;
  if(kind==="foot") return <div style={wrap}><svg width="40%" viewBox="0 0 70 90"><path d="M20 78c-10-6-14-22-14-40C6 18 18 6 36 6c14 0 22 10 22 26 0 10-4 16-4 26 0 8-6 14-16 14-6 0-12 2-18 6Z" fill={c}/></svg></div>;
  if(kind==="brow") return <div style={wrap}><svg width="50%" viewBox="0 0 100 40"><path d="M6 28c20-18 60-22 88-12-26-2-58 2-78 18-6 4-12-2-10-6Z" fill={d}/></svg></div>;
  if(kind==="sparkle"||kind==="spark") return <div style={wrap}><svg width="40%" viewBox="0 0 80 80"><path d="M40 6l7 22 22 7-22 7-7 22-7-22-22-7 22-7z" fill={c}/></svg></div>;
  return <div style={wrap}><svg width="46%" viewBox="0 0 90 70"><rect x="6" y="14" width="78" height="50" rx="8" fill={c}/><path d="M6 26h78" stroke={d} strokeWidth="4"/></svg></div>;
}

// ---------- Store ----------
export const ShopContext = React.createContext(null);
export const useShop = () => React.useContext(ShopContext);

export function ShopProvider({children}){
  const [lang, setLang] = React.useState(()=>localStorage.getItem("nm_lang")||"ro");
  const [cart, setCart] = React.useState(()=>JSON.parse(localStorage.getItem("nm_cart")||"[]"));
  const [favs, setFavs] = React.useState(()=>JSON.parse(localStorage.getItem("nm_favs")||"[]"));
  const [orders, setOrders] = React.useState(()=>JSON.parse(localStorage.getItem("nm_orders")||"[]"));
  const [drawer, setDrawer] = React.useState(null); // 'cart' | 'fav' | 'menu' | 'catalog'
  const [toast, setToast] = React.useState(null);
  const [allProducts, setAllProducts] = React.useState([]);
  const [knownProducts, setKnownProducts] = React.useState({});
  const [catalogLoading, setCatalogLoading] = React.useState(false);
  const toastT = React.useRef(0);
  const hasDrawer = Boolean(drawer);

  React.useEffect(()=>localStorage.setItem("nm_lang",lang),[lang]);
  React.useEffect(()=>localStorage.setItem("nm_cart",JSON.stringify(cart)),[cart]);
  React.useEffect(()=>localStorage.setItem("nm_favs",JSON.stringify(favs)),[favs]);
  React.useEffect(()=>localStorage.setItem("nm_orders",JSON.stringify(orders)),[orders]);
  React.useEffect(()=>{
    if(!hasDrawer) return;
    const y = window.scrollY || window.pageYOffset || 0;
    const {style} = document.body;
    const prev = {
      position:style.position,
      top:style.top,
      left:style.left,
      right:style.right,
      width:style.width,
      overflow:style.overflow,
    };
    style.position = "fixed";
    style.top = `-${y}px`;
    style.left = "0";
    style.right = "0";
    style.width = "100%";
    style.overflow = "hidden";
    return ()=>{
      Object.assign(style, prev);
      window.scrollTo(0,y);
    };
  },[hasDrawer]);

  const t = (k)=> (I18N[lang]||{})[k] ?? k;
  const name = (p)=> p[lang]||p.ro;

  const rememberProduct = React.useCallback((p)=>{
    if(!p || !p.key) return;
    setKnownProducts(prev=> prev[p.key] === p ? prev : {...prev, [p.key]:p});
  },[]);
  const indexProducts = React.useCallback((items)=>{
    setKnownProducts(prev=>{
      let changed = false;
      const next = {...prev};
      for(const p of items){
        if(p && p.key && next[p.key] !== p){ next[p.key] = p; changed = true; }
      }
      return changed ? next : prev;
    });
  },[]);
  const ensureCatalog = React.useCallback(()=>{
    if(allProducts.length) return Promise.resolve(allProducts);
    setCatalogLoading(true);
    return loadCatalogProducts()
      .then(items=>{ setAllProducts(items); indexProducts(items); return items; })
      .finally(()=>setCatalogLoading(false));
  },[allProducts, indexProducts]);

  // cart/favorites store the stable product key (SKU or hash), not the volatile row id
  const find = React.useCallback((key)=> knownProducts[key] || allProducts.find(p=>p.key===key), [allProducts, knownProducts]);

  React.useEffect(()=>{
    if((cart.length || favs.length) && !allProducts.length) ensureCatalog();
  },[allProducts.length, cart.length, favs.length, ensureCatalog]);

  // Drop cart/favorite entries that no longer resolve after the catalog is loaded
  // (e.g. legacy carts saved under the old numeric ids, or removed products)
  React.useEffect(()=>{
    if(!allProducts.length) return;
    setCart(c=>{ const f=c.filter(i=>find(i.id)); return f.length===c.length ? c : f; });
    setFavs(f=>{ const g=f.filter(k=>find(k)); return g.length===f.length ? f : g; });
  },[allProducts.length, find]);

  const showToast = (msg)=>{
    setToast(msg); clearTimeout(toastT.current);
    toastT.current = setTimeout(()=>setToast(null), 2200);
  };
  const addToCart = (p)=>{
    rememberProduct(p);
    setCart(c=>{
      const ex=c.find(i=>i.id===p.key);
      if(ex) return c.map(i=>i.id===p.key?{...i,q:i.q+1}:i);
      return [...c,{id:p.key,q:1}];
    });
    showToast(t("addedToast"));
  };
  const setQty=(id,q)=> setCart(c=> q<=0? c.filter(i=>i.id!==id): c.map(i=>i.id===id?{...i,q}:i));
  const removeFromCart=(id)=> setCart(c=>c.filter(i=>i.id!==id));
  const clearCart=()=> setCart([]);
  const toggleFav=(id)=>{ if(!find(id)) ensureCatalog(); setFavs(f=> f.includes(id)? f.filter(x=>x!==id): [...f,id]); };

  const cartCount = cart.reduce((s,i)=>s+i.q,0);
  const cartTotal = cart.reduce((s,i)=>{const p=find(i.id);return s+(p?p.price*i.q:0)},0);

  // Place an order: snapshot the cart + customer details, store it, empty the cart,
  // and return the saved order so the success screen can recap it.
  const submitOrder = (details)=>{
    const no = "NM" + Date.now().toString().slice(-7);
    const items = cart.map(i=>{
      const p = find(i.id);
      return p ? {id:p.key, code:p.code||"", brand:p.brand, name:name(p), price:p.price, q:i.q} : null;
    }).filter(Boolean);
    const discount = items.reduce((s,it)=>{ const p=find(it.id); return s + (p&&p.old>0 ? (p.old-p.price)*it.q : 0); }, 0);
    const order = {
      no, date:new Date().toISOString(), lang,
      items, count:items.reduce((s,it)=>s+it.q,0), total:cartTotal, discount,
      ...details,
    };
    setOrders(o=>[order, ...o].slice(0,50));
    // notify the shop owner via the serverless endpoint (Telegram). Fire-and-forget
    // so checkout never blocks; the endpoint keeps the bot token server-side.
    try{
      const endpoint = (import.meta.env && import.meta.env.VITE_ORDER_ENDPOINT) || "/api/order";
      fetch(endpoint, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(order) }).catch(()=>{});
    }catch{}
    clearCart();
    return order;
  };

  const value = {
    lang,setLang,t,name,
    cart,addToCart,setQty,removeFromCart,clearCart,cartCount,cartTotal,
    orders,submitOrder,
    favs,toggleFav,
    drawer,setDrawer,
    toast,showToast,
    find,allProducts,ensureCatalog,catalogLoading,rememberProduct
  };
  return <ShopContext.Provider value={value}>{children}</ShopContext.Provider>;
}
