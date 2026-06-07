/* ===== Header: top bar + logo + search + catalog button ===== */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { useShop, Icon, Placeholder } from '../shop.jsx'
import { asset } from '../data.js'

export function LogoMark({size=42,color="#1a1a1a"}){
  // stylized "nn" nail monogram
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 48 48" fill="none" style={{width:size,height:size}}>
      <path d="M7 40V20c0-6 3.4-10 8-10 3 0 5 1.6 6 4 1-2.4 3-4 6-4 4.6 0 8 4 8 10v20"
        stroke={color} strokeWidth="3.2" strokeLinecap="round"/>
      <path d="M13 11c0-4 1.4-7 3-7s3 3 3 7" stroke={color} strokeWidth="3.2" strokeLinecap="round"/>
      <path d="M29 11c0-4 1.4-7 3-7s3 3 3 7" stroke={color} strokeWidth="3.2" strokeLinecap="round"/>
    </svg>
  );
}
export function Logo({onClick}){
  // Uses the real brand logo at public/images/logo.png; until that file exists
  // it falls back to the built-in SVG monogram + wordmark so nothing looks broken.
  const [ok,setOk] = React.useState(true);
  return (
    <div className="logo" onClick={onClick} role="button">
      {ok
        ? <img className="brandimg" src={asset("images/logo.png")} alt="Nail Mania" onError={()=>setOk(false)}/>
        : <><LogoMark/><div className="txt"><b>Nail</b><i>Mania</i></div></>}
    </div>
  );
}

export function Topbar(){
  const {t,lang,setLang} = useShop();
  return (
    <div className="topbar">
      <div className="wrap">
        <div className="promo"><Icon n="truck" s={17}/><span>{t("topPromo")}</span></div>
        <div className="tright">
          <span className="hours">{t("hours")}</span>
          <div className="lang" role="group" aria-label="Language">
            <button className={lang==="ro"?"on":""} onClick={()=>setLang("ro")}>RO</button>
            <button className={lang==="ru"?"on":""} onClick={()=>setLang("ru")}>RU</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SearchBox(){
  const {t,name,allProducts} = useShop();
  const navigate = useNavigate();
  const [q,setQ] = React.useState("");
  const [open,setOpen] = React.useState(false);
  const boxRef = React.useRef(null);
  React.useEffect(()=>{
    const h=(e)=>{ if(boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown",h); return ()=>document.removeEventListener("mousedown",h);
  },[]);
  const results = React.useMemo(()=>{
    const s=q.trim().toLowerCase(); if(!s) return [];
    return allProducts.filter(p=>
      (p.ro+" "+p.ru+" "+p.brand+" "+(p.code||"")).toLowerCase().includes(s)
    ).slice(0,6);
  },[q,allProducts]);
  return (
    <div className="searchbox" ref={boxRef}>
      <input value={q} placeholder={t("searchPh")}
        onChange={e=>{setQ(e.target.value);setOpen(true);}}
        onFocus={()=>setOpen(true)} aria-label={t("search")}/>
      <button className="go"><Icon n="search" s={18}/><span className="gotxt">{t("search")}</span></button>
      {open && q.trim() && (
        <div className="sresults nm-scroll" style={{maxHeight:380,overflowY:"auto"}}>
          {results.length===0
            ? <div className="empty">{t("noResults")}</div>
            : <>
                <div className="head">{results.length} {t("results")}</div>
                {results.map(p=>(
                  <div className="row" key={p.key} onClick={()=>{navigate("/product/"+p.key);setOpen(false);setQ("");}}>
                    <Placeholder g={p.g} radius={9} img={p.img} label={name(p)}/>
                    <div style={{minWidth:0}}>
                      <div className="nm" style={{whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",maxWidth:200}}>{name(p)}</div>
                      <div className="br">{p.brand}</div>
                    </div>
                    <div className="pr">{p.price} {t("lei")}</div>
                  </div>
                ))}
              </>}
        </div>
      )}
    </div>
  );
}

export function Header(){
  const {t,setDrawer,drawer,cartCount,favs} = useShop();
  const navigate = useNavigate();
  const [stuck,setStuck] = React.useState(false);
  React.useEffect(()=>{
    const h=()=>setStuck(window.scrollY>6);
    window.addEventListener("scroll",h,{passive:true}); h();
    return ()=>window.removeEventListener("scroll",h);
  },[]);
  const scrollTop=()=>{ navigate("/"); window.scrollTo({top:0,behavior:"smooth"}); };
  return (
    <>
      <Topbar/>
      <header className={"header"+(stuck?" stuck":"")}>
        <div className="wrap">
          <div className="bar">
            <Logo onClick={scrollTop}/>
            <button className={"catbtn"+(drawer==="catalog"?" open":"")}
              onClick={()=>setDrawer(drawer==="catalog"?null:"catalog")}>
              <span className="lines"><i></i><i></i><i></i></span>
              <span className="ctxt">{t("catalog")}</span>
            </button>
            <SearchBox/>
            <div className="actions">
              <button className="act hide-mob" onClick={()=>setDrawer("fav")}>
                <Icon n="heart" s={22}/>
                <span className="lbl">{t("fav")}</span>
                {favs.length>0 && <span className="badge">{favs.length}</span>}
              </button>
              <button className="act act-cart" onClick={()=>setDrawer("cart")}>
                <Icon n="bag" s={22}/>
                <span className="lbl">{t("cart")}</span>
                {cartCount>0 && <span className="badge">{cartCount}</span>}
              </button>
              <button className="act act-menu mobtoggle" onClick={()=>setDrawer("menu")}>
                <Icon n="menu" s={22}/>
                <span className="lbl">{t("menu")}</span>
              </button>
            </div>
          </div>
        </div>
      </header>
    </>
  );
}
