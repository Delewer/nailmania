/* ===== Product card + product sections ===== */
import React from 'react'
import { Link } from 'react-router-dom'
import { useShop, Icon, Placeholder } from '../shop.jsx'

const inStock = (p)=> typeof p.stock !== "number" || p.stock > 0;

export function ProductCard({p}){
  const {t,name,addToCart,favs,toggleFav,rememberProduct} = useShop();
  const isFav = favs.includes(p.key);
  const oos = !inStock(p);
  // transient "added" confirmation that reverts the button to its initial look
  const [added,setAdded] = React.useState(false);
  const addT = React.useRef(0);
  React.useEffect(()=>{ rememberProduct(p); },[p, rememberProduct]);
  React.useEffect(()=>()=>clearTimeout(addT.current),[]);
  const onAdd = ()=>{ addToCart(p); setAdded(true); clearTimeout(addT.current); addT.current=setTimeout(()=>setAdded(false),1400); };
  const tag = p.badge==="new" ? {c:"new",txt:t("newBadge")}
            : p.badge==="sale" ? {c:"sale",txt:"-"+Math.round((1-p.price/p.old)*100)+"%"}
            : p.badge==="hit" ? {c:"hit",txt:"HIT"} : null;
  return (
    <div className={"card"+(oos?" oos":"")}>
      <div className="media">
        <Link to={"/product/"+p.key} aria-label={name(p)}>
          <Placeholder g={p.g} icon="bottle" ratio="1" radius={0} img={p.img} label={name(p)}/>
        </Link>
        <div className="badges">{oos ? <span className="tag soldout">{t("outOfStock")}</span> : tag && <span className={"tag "+tag.c}>{tag.txt}</span>}</div>
        <button className={"favbtn"+(isFav?" on":"")} onClick={()=>toggleFav(p.key)} aria-label={t("fav")}>
          <Icon n="heart" s={19} fill={isFav}/>
        </button>
      </div>
      <div className="body">
        <div className="brand">{p.brand}</div>
        <Link to={"/product/"+p.key} className="pname-link"><p className="pname">{name(p)}</p></Link>
        <div className="priceRow">
          <span className="price">{p.price} <small>{t("lei")}</small></span>
          {p.old>0 && <span className="old">{p.old} {t("lei")}</span>}
        </div>
        {oos
          ? <button className="addbtn soldout" disabled>{t("outOfStock")}</button>
          : <button className={"addbtn"+(added?" in":"")} onClick={onAdd}>
              {added ? <><Icon n="check" s={17}/>{t("inCart")}</> : <><Icon n="bag" s={17}/>{t("addCart")}</>}
            </button>}
      </div>
    </div>
  );
}

// numbered pagination with a sliding window (1 … 9 10 11 … 27) + prev/next arrows.
// shared by the home sections, category and brand pages.
function pageWindow(page,pages){
  if(pages<=7) return Array.from({length:pages},(_,i)=>i);
  const set=new Set([0,pages-1,page,page-1,page+1]);
  const nums=[...set].filter(n=>n>=0&&n<pages).sort((a,b)=>a-b);
  const out=[];
  for(let i=0;i<nums.length;i++){ if(i>0&&nums[i]-nums[i-1]>1) out.push("…"); out.push(nums[i]); }
  return out;
}
export function Pager({page,pages,onSelect}){
  if(pages<=1) return null;
  return (
    <div className="pager">
      <button className="nav" disabled={page===0} onClick={()=>onSelect(page-1)} aria-label="prev">‹</button>
      {pageWindow(page,pages).map((it,i)=> it==="…"
        ? <span key={"g"+i} className="gap">…</span>
        : <button key={it} className={it===page?"on":""} onClick={()=>onSelect(it)} aria-label={"page "+(it+1)}>{it+1}</button>
      )}
      <button className="nav" disabled={page===pages-1} onClick={()=>onSelect(page+1)} aria-label="next">›</button>
    </div>
  );
}

export function ProductSection({id,titleKey,items,perPage=8}){
  const {t,setDrawer} = useShop();
  const [page,setPage] = React.useState(0);
  const pages = Math.ceil(items.length/perPage);
  const slice = items.slice(page*perPage,(page+1)*perPage);
  return (
    <section className="section" id={id}>
      <div className="wrap">
        <div className="sec-head">
          <h2>{t(titleKey)}</h2>
          <button className="all" onClick={()=>setDrawer("catalog")}>{t("all")} <Icon n="chev" s={16}/></button>
        </div>
        <div className="prod-grid">
          {slice.map(p=><ProductCard key={p.key} p={p}/>)}
        </div>
        <Pager page={page} pages={pages} onSelect={setPage}/>
      </div>
    </section>
  );
}
