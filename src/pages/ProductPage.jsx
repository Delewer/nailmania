/* ===== Product detail page ===== */
import React from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useShop, Icon, Placeholder } from '../shop.jsx'
import { ProductCard } from '../components/Products.jsx'
import { findProduct, findCategory, productCode, productDesc, productSpecs, relatedProducts, productGallery, inStock } from '../data.js'

export default function ProductPage(){
  const { id } = useParams();
  const navigate = useNavigate();
  const { t, lang, name, addToCart, favs, toggleFav, setDrawer } = useShop();
  const [shot, setShot] = React.useState(0);
  const [qty, setQty] = React.useState(1);
  const [added, setAdded] = React.useState(false);
  const addT = React.useRef(0);
  React.useEffect(()=>()=>clearTimeout(addT.current),[]);

  React.useEffect(()=>{ window.scrollTo({top:0}); setShot(0); setQty(1); setAdded(false); }, [id]);

  const p = findProduct(id);
  if(!p){
    return (
      <div className="wrap page">
        <div className="page-empty">
          <Icon n="search" s={60}/>
          <h2>{t("notFound")}</h2>
          <Link className="btn btn-dark" to="/">{t("backHome")}</Link>
        </div>
      </div>
    );
  }

  const cat = findCategory(p.cat);
  const isFav = favs.includes(p.key);
  const oos = !inStock(p);
  const [descA, descB] = productDesc(p, lang);
  const save = p.old>0 ? Math.round((1 - p.price/p.old)*100) : 0;
  // gallery: distinct themed photos, with gradient variants as load/error fallback
  const gallery = productGallery(p, 4);
  const shades = [p.g, [p.g[1], p.g[0]], ["#fff", p.g[0]], [p.g[0], "#fff"]];

  const handleAdd = ()=>{
    for(let i=0;i<qty;i++) addToCart(p);
    setAdded(true); clearTimeout(addT.current); addT.current=setTimeout(()=>setAdded(false),1400);
  };
  const buyNow = ()=>{ for(let i=0;i<qty;i++) addToCart(p); navigate("/checkout"); };
  const related = relatedProducts(p, 4);

  return (
    <div className="wrap page">
      <nav className="crumbs">
        <Link to="/">{t("home")}</Link>
        <Icon n="chev" s={14}/>
        {cat && <><Link to={"/category/"+cat.id}>{name(cat)}</Link><Icon n="chev" s={14}/></>}
        <span className="cur">{name(p)}</span>
      </nav>

      <div className="pd">
        <div className="pd-gallery">
          <div className="pd-main"><Placeholder g={shades[shot]} icon="bottle" ratio="1" radius={0} img={gallery[shot]} label={name(p)}/></div>
          <div className="pd-thumbs">
            {gallery.map((src,i)=>(
              <div key={i} className={"pd-thumb"+(i===shot?" on":"")} onClick={()=>setShot(i)}>
                <Placeholder g={shades[i]} icon="bottle" ratio="1" radius={0} img={src} label={name(p)}/>
              </div>
            ))}
          </div>
        </div>

        <div className="pd-info">
          <div className="pd-brand">{p.brand}</div>
          <h1>{name(p)}</h1>
          <div className="pd-meta">
            <span className={"stock"+(oos?" out":"")}><span className="dot"/>{oos?t("outOfStock"):t("inStock")}</span>
            <span>{t("code")}: {productCode(p)}</span>
          </div>
          <div className="pd-price">
            <span className="now">{p.price} <small>{t("lei")}</small></span>
            {p.old>0 && <span className="was">{p.old} {t("lei")}</span>}
            {save>0 && <span className="save">-{save}%</span>}
          </div>

          <div className="pd-buy">
            {oos ? (
              <button className="addbtn soldout" disabled style={{flex:1}}>{t("outOfStock")}</button>
            ) : (
              <>
                <div className="qty">
                  <button onClick={()=>setQty(q=>Math.max(1,q-1))} aria-label="-"><Icon n="minus" s={16}/></button>
                  <span>{qty}</span>
                  <button onClick={()=>setQty(q=>q+1)} aria-label="+"><Icon n="plus" s={16}/></button>
                </div>
                <button className={"addbtn"+(added?" in":"")} onClick={handleAdd}>
                  {added ? <><Icon n="check" s={18}/>{t("inCart")}</> : <><Icon n="bag" s={18}/>{t("addCart")}</>}
                </button>
              </>
            )}
            <button className={"favbtn-lg"+(isFav?" on":"")} onClick={()=>toggleFav(p.key)} aria-label={t("fav")}>
              <Icon n="heart" s={20} fill={isFav}/>
            </button>
          </div>
          {!oos && <button className="pd-oneclick" onClick={buyNow}><Icon n="check" s={18}/>{t("buyOneClick")}</button>}

          <div className="pd-block">
            <h2>{t("descTitle")}</h2>
            <p>{descA}</p>
            <p>{descB}</p>
          </div>

          <div className="pd-block">
            <h2>{t("charTitle")}</h2>
            <ul className="pd-chars">
              <li><span>{t("charBrand")}</span><b>{p.brand}</b></li>
              {cat && <li><span>{t("charCat")}</span><b>{name(cat)}</b></li>}
              {productSpecs(p, lang).map((s,i)=>(
                <li key={i}><span>{s.label}</span><b>{s.value}</b></li>
              ))}
              <li><span>{t("charCode")}</span><b>{productCode(p)}</b></li>
              <li><span>{t("charAvail")}</span><b>{oos?t("outOfStock"):t("inStock")}</b></li>
            </ul>
          </div>
        </div>
      </div>

      <section className="section" style={{paddingBottom:0}}>
        <div className="sec-head"><h2>{t("relatedTitle")}</h2></div>
        <div className="prod-grid">
          {related.map(rp=><ProductCard key={rp.key} p={rp}/>)}
        </div>
      </section>
    </div>
  );
}
