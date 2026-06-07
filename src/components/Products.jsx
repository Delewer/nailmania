/* ===== Product card + product sections ===== */
import React from 'react'
import { Link } from 'react-router-dom'
import { useShop, Icon, Placeholder } from '../shop.jsx'

export function ProductCard({p}){
  const {t,name,addToCart,favs,toggleFav} = useShop();
  const isFav = favs.includes(p.key);
  // transient "added" confirmation that reverts the button to its initial look
  const [added,setAdded] = React.useState(false);
  const addT = React.useRef(0);
  React.useEffect(()=>()=>clearTimeout(addT.current),[]);
  const onAdd = ()=>{ addToCart(p); setAdded(true); clearTimeout(addT.current); addT.current=setTimeout(()=>setAdded(false),1400); };
  const tag = p.badge==="new" ? {c:"new",txt:t("newBadge")}
            : p.badge==="sale" ? {c:"sale",txt:"-"+Math.round((1-p.price/p.old)*100)+"%"}
            : p.badge==="hit" ? {c:"hit",txt:"HIT"} : null;
  return (
    <div className="card">
      <div className="media">
        <Link to={"/product/"+p.key} aria-label={name(p)}>
          <Placeholder g={p.g} icon="bottle" ratio="1" radius={0} img={p.img} label={name(p)}/>
        </Link>
        <div className="badges">{tag && <span className={"tag "+tag.c}>{tag.txt}</span>}</div>
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
        <button className={"addbtn"+(added?" in":"")} onClick={onAdd}>
          {added ? <><Icon n="check" s={17}/>{t("inCart")}</> : <><Icon n="bag" s={17}/>{t("addCart")}</>}
        </button>
      </div>
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
        {pages>1 && (
          <div className="pager">
            {Array.from({length:pages}).map((_,i)=>(
              <button key={i} className={i===page?"on":""} onClick={()=>setPage(i)} aria-label={"page "+(i+1)}/>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
