/* ===== Brands + About/Delivery + Social + Footer ===== */
import React from 'react'
import { Link } from 'react-router-dom'
import { useShop, Icon } from '../shop.jsx'
import { asset } from '../data.js'
import { CATS, CATALOG_ERROR } from '../catalog-data.js'

export function Brands(){
  const {t} = useShop();
  const [brands, setBrands] = React.useState([]);
  React.useEffect(()=>{
    let alive = true;
    import('../catalog-data.js').then(({ CATALOG_BRANDS })=>{
      if(alive) setBrands(CATALOG_BRANDS);
    });
    return ()=>{ alive = false; };
  },[]);

  if(CATALOG_ERROR) return null;

  return (
    <section className="section brands" id="brands">
      <div className="wrap">
        <div className="sec-head">
          <div>
            <h2>{t("brandsTitle")}</h2>
            <p className="muted" style={{margin:"8px 0 0",fontSize:15}}>{t("brandsSub")}</p>
          </div>
        </div>
        <div className="brand-grid">
          {brands.map(({brand,count})=>(
            <Link className="brand-cell" key={brand} to={"/brand/"+encodeURIComponent(brand)}>
              <span>{brand}</span>
              <i className="brand-cnt">{count}</i>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

export function About(){
  const {t} = useShop();
  return (
    <section className="section" id="delivery">
      <div className="wrap">
        <div className="about">
          <div>
            <h1>{t("deliveryTitle")}</h1>
            <p className="sub">{t("deliverySub")}</p>
            <ul>
              {["d1","d2"].map(k=>(
                <li key={k}><Icon n="check" s={20}/>{t(k)}</li>
              ))}
            </ul>
            <h3>{t("termsTitle")}</h3>
            <ul className="terms">
              {["t1","t2"].map(k=>(
                <li key={k}><Icon n="truck" s={20}/>{t(k)}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Social(){
  return (
    <div className="wrap">
      <div className="social">
        <a className="ig" href="https://www.instagram.com/nailmania_md" target="_blank" rel="noreferrer" aria-label="Instagram"><Icon n="ig" s={28} fill/></a>
        <a className="wa" href="https://wa.me/37368067486" target="_blank" rel="noreferrer" aria-label="WhatsApp"><Icon n="wa" s={28} fill/></a>
        <a className="tg" href="https://www.t.me/nailmania_md" target="_blank" rel="noreferrer" aria-label="Telegram"><Icon n="tg" s={28} fill/></a>
      </div>
    </div>
  );
}

export function Payment(){
  const {t} = useShop();
  const groups = [
    { icon:"truck", title:t("payOnDelivery"), items:[t("payDel1"), t("payDel2")] },
    { icon:"store", title:t("payPickup"),     items:[t("payPick1"), t("payPick2"), t("payPick3")] },
  ];
  return (
    <section className="section info-sec" id="plata">
      <div className="wrap">
        <div className="sec-head"><h1>{t("payTitle")}</h1></div>
        <p className="info-lead">{t("payLead")}</p>
        <div className="pay-grid">
          {groups.map(g=>(
            <div className="pay-card" key={g.title}>
              <Icon n={g.icon} s={22}/>
              <div>
                <b>{g.title}</b>
                <ul>{g.items.map(it=><li key={it}>{it}</li>)}</ul>
              </div>
            </div>
          ))}
        </div>
        <p className="info-note">{t("payNote")}</p>
      </div>
    </section>
  );
}

export function Contacts(){
  const {t} = useShop();
  return (
    <section className="section info-sec" id="contacte">
      <div className="wrap">
        <div className="sec-head"><h1>{t("contact")}</h1></div>
        <p className="info-lead">{t("contIntro")}</p>
        <div className="info-grid">
          <div className="info-row"><Icon n="pin" s={20} fill/><div className="ci-txt"><b>{t("contAddr")}</b></div></div>
          <a className="info-row" href="tel:+37368067486"><Icon n="phone" s={20}/><div className="ci-txt"><span>{t("contPhoneLabel")}</span><b>+373 68 067 486</b></div></a>
          <a className="info-row" href="mailto:nailmania18@gmail.com"><Icon n="mail" s={20}/><div className="ci-txt"><span>{t("contEmailLabel")}</span><b>nailmania18@gmail.com</b></div></a>
          <a className="info-row" href="https://www.instagram.com/nailmania_md" target="_blank" rel="noreferrer"><Icon n="ig" s={20} fill/><div className="ci-txt"><span>Instagram</span><b>@nailmania_md</b></div></a>
          <div className="info-row"><Icon n="store" s={20}/><div className="ci-txt"><span>{t("contHoursLabel")}</span><b>{t("workHours")}</b></div></div>
          <div className="info-row"><Icon n="check" s={20}/><div className="ci-txt"><b>{t("contOrders")}</b></div></div>
        </div>
      </div>
    </section>
  );
}

export function NotFound(){
  const {t} = useShop();
  return (
    <div className="wrap page">
      <div className="page-empty">
        <Icon n="search" s={60}/>
        <h1>{t("pageNotFound")}</h1>
        <p>{t("pageNotFoundText")}</p>
        <Link className="btn btn-dark" to="/">{t("backHome")}</Link>
      </div>
    </div>
  );
}

export function Footer(){
  const {t,name} = useShop();
  const cats = CATS.slice(0,7);
  return (
    <footer className="footer">
      <div className="wrap">
        <div className="foot-grid">
          <div>
            <div className="flogo"><img className="footer-logo-img" src={asset("images/logo-high.png")} alt="Nail Mania" /></div>
            <p className="ab">{t("footAbout")}</p>
          </div>
          <div>
            <h4>{t("colCatalog")}</h4>
            <ul>{cats.map(c=><li key={c.id}><Link to={"/category/"+c.id}>{name(c)}</Link></li>)}</ul>
          </div>
          <div>
            <h4>{t("colInfo")}</h4>
            <ul>
              <li><Link to="/livrare">{t("navDelivery")}</Link></li>
              <li><Link to="/plata">{t("navPayment")}</Link></li>
              <li><Link to="/contacte">{t("navContact")}</Link></li>
              <li><Link to="/#brands">{t("navBrands")}</Link></li>
            </ul>
          </div>
          <div>
            <h4>{t("colContact")}</h4>
            <a className="ci" href="tel:+37368067486"><Icon n="phone" s={18}/><span>+373 68 067 486</span></a>
            <a className="ci" href="mailto:nailmania18@gmail.com"><Icon n="mail" s={18}/><span>nailmania18@gmail.com</span></a>
            <div className="ci"><Icon n="pin" s={18} fill/><span>str. Romană 66/2,<br/>Ungheni, Moldova</span></div>
          </div>
        </div>
        <div className="foot-bottom">
          <span>© 2026 Nail Mania — {t("footAbout")}</span>
          <span>RO · RU</span>
        </div>
      </div>
    </footer>
  );
}
