/* ===== Catalog mega-menu, drawers (cart/fav/menu), toast ===== */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useShop, Icon, Placeholder, PhShape } from '../shop.jsx'
import { CATS } from '../data.js'

export function CatalogMega(){
  const {name,setDrawer} = useShop();
  const navigate = useNavigate();
  const openCat = (cid)=>{ setDrawer(null); navigate("/category/"+cid); };
  const [top,setTop] = React.useState(118);
  React.useEffect(()=>{
    const h=document.querySelector(".header");
    if(h) setTop(h.getBoundingClientRect().bottom);
  },[]);
  return (
    <>
      <div className="megabg" onClick={()=>setDrawer(null)}/>
      <div className="mega" style={{position:"fixed",top,left:0,right:0}}>
        <div className="wrap">
          <div className="grid">
            {CATS.map(c=>(
              <a key={c.id} onClick={()=>openCat(c.id)}>
                <span className="dot" style={{background:`linear-gradient(140deg,${c.g[0]},${c.g[1]})`}}>
                  <PhShape kind={c.icon}/>
                </span>
                <span>
                  <span className="mt">{name(c)}</span>
                </span>
              </a>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

export function CartLine({item}){
  const {find,name,t,setQty,removeFromCart} = useShop();
  const p=find(item.id); if(!p) return null;
  return (
    <div className="litem">
      <Placeholder g={p.g} icon="bottle" radius={11} img={p.img} label={name(p)}/>
      <div className="info">
        <div className="br">{p.brand}</div>
        <div className="nm">{name(p)}</div>
        <div className="pr">{p.price*item.q} {t("lei")}</div>
        <div className="qty">
          <button onClick={()=>setQty(item.id,item.q-1)}><Icon n="minus" s={16}/></button>
          <span>{item.q}</span>
          <button onClick={()=>setQty(item.id,item.q+1)}><Icon n="plus" s={16}/></button>
        </div>
      </div>
      <button className="rm" onClick={()=>removeFromCart(item.id)} aria-label="remove"><Icon n="trash" s={18}/></button>
    </div>
  );
}

export function CartDrawer(){
  const {t,cart,cartTotal,clearCart,setDrawer} = useShop();
  const navigate = useNavigate();
  const goCheckout = ()=>{ setDrawer(null); navigate("/checkout"); };
  return (
    <Drawer title={t("cart")} side="right">
      {cart.length===0
        ? <div className="empty"><Icon n="bag" s={56}/><p>{t("emptyCart")}</p>
            <button className="btn btn-dark" onClick={()=>setDrawer(null)}>{t("goShop")}</button></div>
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
  const {t,favs,find,name,toggleFav,addToCart,setDrawer} = useShop();
  const items = favs.map(find).filter(Boolean);
  return (
    <Drawer title={t("fav")} side="right">
      {items.length===0
        ? <div className="empty"><Icon n="heart" s={56}/><p>{t("emptyFav")}</p>
            <button className="btn btn-dark" onClick={()=>setDrawer(null)}>{t("goShop")}</button></div>
        : <div className="dbody nm-scroll">
            {items.map(p=>(
              <div className="litem" key={p.key}>
                <Placeholder g={p.g} icon="bottle" radius={11} img={p.img} label={name(p)}/>
                <div className="info">
                  <div className="br">{p.brand}</div>
                  <div className="nm">{name(p)}</div>
                  <div className="pr">{p.price} {t("lei")}</div>
                  <button className="favadd" onClick={()=>addToCart(p)}><Icon n="bag" s={15}/> {t("addCart")}</button>
                </div>
                <button className="rm" onClick={()=>toggleFav(p.key)} aria-label="remove"><Icon n="close" s={18}/></button>
              </div>
            ))}
          </div>}
    </Drawer>
  );
}

export function MobileMenu(){
  const {t,lang,setLang,setDrawer,favs,cartCount} = useShop();
  const navigate = useNavigate();
  // works from any page: go home (if needed) and let Home scroll to the section
  const go=(hash)=>{ setDrawer(null); navigate("/"+hash); };
  const chev = <Icon n="chev" s={18}/>;
  return (
    <Drawer title={t("menuTitle")} side="left">
      <div className="dbody nm-scroll">
        <div className="mmenu">
          <div className="mtitle">{t("langLabel")}</div>
          <div className="mlang">
            <button className={lang==="ro"?"on":""} onClick={()=>setLang("ro")}>RO · Română</button>
            <button className={lang==="ru"?"on":""} onClick={()=>setLang("ru")}>RU · Русский</button>
          </div>
          <a onClick={()=>setDrawer("catalog")}><span className="mi"><Icon n="store" s={19}/>{t("catalog")}</span>{chev}</a>
          <a onClick={()=>go("#new")}><span className="mi"><Icon n="spark" s={19}/>{t("navNew")}</span>{chev}</a>
          <a onClick={()=>go("#sale")}><span className="mi"><Icon n="star" s={19}/>{t("navSale")}</span>{chev}</a>

          <div className="mtitle">{t("colInfo")}</div>
          <a onClick={()=>go("#delivery")}><span className="mi"><Icon n="truck" s={19}/>{t("navDelivery")}</span>{chev}</a>
          <a onClick={()=>go("#plata")}><span className="mi"><Icon n="card" s={19}/>{t("navPayment")}</span>{chev}</a>
          <a onClick={()=>go("#contacte")}><span className="mi"><Icon n="phone" s={19}/>{t("navContact")}</span>{chev}</a>

          <div className="mtitle">{t("menu")}</div>
          <a onClick={()=>setDrawer("fav")}><span className="mi"><Icon n="heart" s={19}/>{t("fav")}</span><span className="mcount">{favs.length>0&&<i>{favs.length}</i>}{chev}</span></a>
          <a onClick={()=>setDrawer("cart")}><span className="mi"><Icon n="bag" s={19}/>{t("cart")}</span><span className="mcount">{cartCount>0&&<i>{cartCount}</i>}{chev}</span></a>
        </div>
      </div>
    </Drawer>
  );
}

export function Drawer({title,side,children}){
  const {setDrawer} = useShop();
  return (
    <>
      <div className="scrim" onClick={()=>setDrawer(null)}/>
      <aside className={"drawer"+(side==="left"?" left":"")}>
        <div className="dhead">
          <h3>{title}</h3>
          <button className="dclose" onClick={()=>setDrawer(null)} aria-label="close"><Icon n="close" s={20}/></button>
        </div>
        {children}
      </aside>
    </>
  );
}

export function Toast(){
  const {toast} = useShop();
  if(!toast) return null;
  return <div className="toast"><Icon n="check" s={18}/>{toast}</div>;
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
