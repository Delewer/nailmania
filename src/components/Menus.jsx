/* ===== Catalog mega-menu, drawers (cart/fav/menu), toast ===== */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useShop, Icon, Placeholder } from '../shop.jsx'
import { CATS, CATALOG_ERROR } from '../catalog-data.js'
import { CatalogUnavailable } from './CatalogState.jsx'
import { useAuth } from '../auth.jsx'
import { accountText } from '../account-copy.js'
import { useDialogFocus } from '../dialog-a11y.js'
import { cartLineLimit } from '../cart-quantity.js'

export function CatalogMega(){
  const {name,setDrawer,t} = useShop();
  const navigate = useNavigate();
  const close = React.useCallback(()=>setDrawer(null),[setDrawer]);
  const dialogRef = useDialogFocus(close);
  const openCat = (cid)=>{ close(); navigate("/category/"+cid); };
  const [panel,setPanel] = React.useState({top:118,maxHeight:640});
  React.useLayoutEffect(()=>{
    const update = ()=>{
      const h=document.querySelector(".header");
      const top = Math.max(0, Math.round(h ? h.getBoundingClientRect().bottom : 0));
      setPanel({top,maxHeight:Math.max(180, window.innerHeight - top)});
    };
    update();
    window.addEventListener("resize",update);
    return ()=>window.removeEventListener("resize",update);
  },[]);
  return (
    <>
      <div className="megabg" aria-hidden="true" onClick={close}/>
      <div
        className="mega nm-scroll"
        id="catalog-mega"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("catalog")}
        tabIndex={-1}
        style={{position:"fixed",top:panel.top,left:0,right:0,maxHeight:panel.maxHeight}}
      >
        <div className="wrap">
          {CATALOG_ERROR ? <CatalogUnavailable/> : (
            <div className="grid">
              {CATS.map(c=>(
                <button type="button" key={c.id} onClick={()=>openCat(c.id)}>
                  <span className="dot">
                    <Placeholder g={c.g} icon={c.icon} img={c.img} ratio="1" radius={10} label={name(c)}/>
                  </span>
                  <span>
                    <span className="mt">{name(c)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export function CartLine({item}){
  const {find,name,t,setQty,removeFromCart} = useShop();
  const p=find(item.id); if(!p) return null;
  const atLineLimit = item.q>=cartLineLimit(p);
  return (
    <div className="litem">
      <Placeholder g={p.g} icon="bottle" radius={11} img={p.img} label={name(p)}/>
      <div className="info">
        <div className="br">{p.brand}</div>
        <div className="nm">{name(p)}</div>
        <div className="pr">{p.price*item.q} {t("lei")}</div>
        <div className="qty">
          <button type="button" onClick={()=>setQty(item.id,item.q-1)} aria-label={t("decreaseQty")}><Icon n="minus" s={16}/></button>
          <span aria-live="polite">{item.q}</span>
          <button type="button" onClick={()=>setQty(item.id,item.q+1)} disabled={atLineLimit} aria-label={atLineLimit?t("stockLimitReached"):t("increaseQty")}><Icon n="plus" s={16}/></button>
        </div>
      </div>
      <button type="button" className="rm" onClick={()=>removeFromCart(item.id)} aria-label={t("removeItem")}><Icon n="trash" s={18}/></button>
    </div>
  );
}

export function CartDrawer(){
  const {t,cart,cartTotal,clearCart,setDrawer,find,allProducts,ensureCatalog,catalogLoading,catalogLoaded,catalogError} = useShop();
  const navigate = useNavigate();
  const resolved = cart.map(i=>find(i.id)).filter(Boolean);
  const unavailable = cart.length>0 && resolved.length===0 && Boolean(catalogError);
  const loading = cart.length>0 && resolved.length===0 && !unavailable && (!catalogLoaded || catalogLoading || !allProducts.length);
  React.useEffect(()=>{ if(cart.length) ensureCatalog(); },[cart.length, ensureCatalog]);
  const goCheckout = ()=>{ setDrawer(null); navigate("/checkout"); };
  return (
    <Drawer title={t("cart")} side="right">
      {cart.length===0
        ? <div className="empty"><Icon n="bag" s={56}/><p>{t("emptyCart")}</p>
            <button className="btn btn-dark" onClick={()=>setDrawer(null)}>{t("goShop")}</button></div>
        : unavailable
        ? <div className="empty"><Icon n="store" s={56}/><p>{t("catalogUnavailableText")}</p>
            <button className="btn btn-dark" onClick={()=>window.location.reload()}>{t("retry")}</button></div>
        : loading
        ? <div className="empty"><Icon n="bag" s={56}/><p>{t("catalog")}...</p></div>
        : <>
            <div className="dbody nm-scroll">{cart.map(it=><CartLine key={it.id} item={it}/>)}</div>
            <div className="dfoot">
              <div className="totrow"><span>{t("total")}</span><b>{cartTotal} {t("lei")}</b></div>
              <button className="checkout" onClick={goCheckout}><Icon n="check" s={20}/>{t("checkout")}</button>
              <button className="clear" onClick={clearCart}>{t("clear")}</button>
            </div>
          </>}
    </Drawer>
  );
}

export function FavDrawer(){
  const {t,favs,find,name,toggleFav,addToCart,setDrawer,allProducts,ensureCatalog,catalogLoading,catalogLoaded,catalogError} = useShop();
  React.useEffect(()=>{ if(favs.length) ensureCatalog(); },[favs.length, ensureCatalog]);
  const items = favs.map(find).filter(Boolean);
  const unavailable = favs.length>0 && items.length===0 && Boolean(catalogError);
  const loading = favs.length>0 && items.length===0 && !unavailable && (!catalogLoaded || catalogLoading || !allProducts.length);
  return (
    <Drawer title={t("fav")} side="right">
      {items.length===0
        ? <div className="empty"><Icon n={unavailable?"store":"heart"} s={56}/><p>{unavailable ? t("catalogUnavailableText") : loading ? `${t("catalog")}...` : t("emptyFav")}</p>
            {unavailable
              ? <button className="btn btn-dark" onClick={()=>window.location.reload()}>{t("retry")}</button>
              : <button className="btn btn-dark" onClick={()=>setDrawer(null)}>{t("goShop")}</button>}
          </div>
        : <div className="dbody nm-scroll">
            {items.map(p=>(
              <div className="litem" key={p.key}>
                <Placeholder g={p.g} icon="bottle" radius={11} img={p.img} label={name(p)}/>
                <div className="info">
                  <div className="br">{p.brand}</div>
                  <div className="nm">{name(p)}</div>
                  <div className="pr">{p.price} {t("lei")}</div>
                  <button className="favadd" onClick={()=>addToCart(p,{source:'favorites'})}><Icon n="bag" s={15}/> {t("addCart")}</button>
                </div>
                <button type="button" className="rm" onClick={()=>toggleFav(p.key)} aria-label={t("removeItem")}><Icon n="close" s={18}/></button>
              </div>
            ))}
          </div>}
    </Drawer>
  );
}

export function MobileMenu(){
  const {t,lang,setLang,setDrawer,favs,cartCount} = useShop();
  const {user} = useAuth();
  const navigate = useNavigate();
  // works from any page: go home (if needed) and let Home scroll to the section
  const go=(hash)=>{ setDrawer(null); navigate("/"+hash); };
  const goPage=(path)=>{ setDrawer(null); navigate(path); };
  const chev = <Icon n="chev" s={18}/>;
  return (
    <Drawer title={t("menuTitle")} side="left">
      <div className="dbody nm-scroll">
        <div className="mmenu">
          <div className="mtitle">{t("langLabel")}</div>
          <div className="mlang">
            <button type="button" className={lang==="ro"?"on":""} aria-pressed={lang==="ro"} onClick={()=>setLang("ro")}>RO · Română</button>
            <button type="button" className={lang==="ru"?"on":""} aria-pressed={lang==="ru"} onClick={()=>setLang("ru")}>RU · Русский</button>
          </div>
          <button type="button" className="menu-link" onClick={()=>setDrawer("catalog")}><span className="mi"><Icon n="store" s={19}/>{t("catalog")}</span>{chev}</button>
          <button type="button" className="menu-link" onClick={()=>go("#new")}><span className="mi"><Icon n="spark" s={19}/>{t("navNew")}</span>{chev}</button>
          <button type="button" className="menu-link" onClick={()=>go("#sale")}><span className="mi"><Icon n="star" s={19}/>{t("navSale")}</span>{chev}</button>

          <div className="mtitle">{t("colInfo")}</div>
          <button type="button" className="menu-link" onClick={()=>goPage("/livrare")}><span className="mi"><Icon n="truck" s={19}/>{t("navDelivery")}</span>{chev}</button>
          <button type="button" className="menu-link" onClick={()=>goPage("/plata")}><span className="mi"><Icon n="card" s={19}/>{t("navPayment")}</span>{chev}</button>
          <button type="button" className="menu-link" onClick={()=>goPage("/contacte")}><span className="mi"><Icon n="phone" s={19}/>{t("navContact")}</span>{chev}</button>

          <div className="mtitle">{t("menu")}</div>
          <button type="button" className="menu-link" onClick={()=>goPage(user?"/account":"/login")}><span className="mi"><Icon n="user" s={19}/>{accountText(lang,user?"account":"signIn")}</span>{chev}</button>
          <button type="button" className="menu-link" onClick={()=>setDrawer("fav")}><span className="mi"><Icon n="heart" s={19}/>{t("fav")}</span><span className="mcount">{favs.length>0&&<i>{favs.length}</i>}{chev}</span></button>
          <button type="button" className="menu-link" onClick={()=>setDrawer("cart")}><span className="mi"><Icon n="bag" s={19}/>{t("cart")}</span><span className="mcount">{cartCount>0&&<i>{cartCount}</i>}{chev}</span></button>
        </div>
      </div>
    </Drawer>
  );
}

export function Drawer({title,side,children}){
  const {setDrawer,t} = useShop();
  const close = React.useCallback(()=>setDrawer(null),[setDrawer]);
  const dialogRef = useDialogFocus(close);
  const titleId = `drawer-${React.useId().replaceAll(':','')}`;
  return (
    <>
      <div className="scrim" aria-hidden="true" onClick={close}/>
      <aside className={"drawer"+(side==="left"?" left":"")} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="dhead">
          <h3 id={titleId}>{title}</h3>
          <button className="dclose" type="button" onClick={close} aria-label={t("close")} data-dialog-initial-focus><Icon n="close" s={20}/></button>
        </div>
        {children}
      </aside>
    </>
  );
}

export function Toast(){
  const {toast} = useShop();
  if(!toast) return null;
  return <div className="toast" role="status" aria-live="polite"><Icon n="check" s={18}/>{toast}</div>;
}

export function Overlays(){
  const {drawer} = useShop();
  return (
    <>
      {drawer==="catalog" && <CatalogMega/>}
      {drawer==="cart" && <CartDrawer/>}
      {drawer==="fav" && <FavDrawer/>}
      {drawer==="menu" && <MobileMenu/>}
      <Toast/>
    </>
  );
}
