/* ===== Brands + About/Delivery + Social + Footer ===== */
import React from 'react'
import { Link } from 'react-router-dom'
import { useShop, Icon, Placeholder } from '../shop.jsx'
import { LogoMark } from './Header.jsx'
import { CATS, ABOUT_IMG } from '../data.js'

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

  return (
    <section className="section brands">
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
            <h2>{t("deliveryTitle")}</h2>
            <p className="sub">{t("deliverySub")}</p>
            <ul>
              {["d1","d2","d3","d4"].map(k=>(
                <li key={k}><Icon n="check" s={20}/>{t(k)}</li>
              ))}
            </ul>
            <h3>{t("termsTitle")}</h3>
            <ul className="terms">
              {["t1","t2","t3","t4","t5"].map(k=>(
                <li key={k}><Icon n="truck" s={20}/>{t(k)}</li>
              ))}
            </ul>
          </div>
          <div className="pic"><Placeholder g={["#f2dcd4","#e8ccd8"]} icon="bottle" ratio="4/5" radius={20} img={ABOUT_IMG} label="Nail Mania"/></div>
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
        <a className="wa" href="#" aria-label="WhatsApp"><Icon n="wa" s={28} fill/></a>
        <a className="tg" href="https://www.t.me/nailmania_md" target="_blank" rel="noreferrer" aria-label="Telegram"><Icon n="tg" s={28} fill/></a>
        <a className="fb" href="#" aria-label="Facebook"><Icon n="fb" s={26} fill/></a>
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
        <div className="sec-head"><h2>{t("payTitle")}</h2></div>
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
        <div className="sec-head"><h2>{t("contact")}</h2></div>
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

export function Footer(){
  const {t,name,setDrawer} = useShop();
  const cats = CATS.slice(0,7);
  return (
    <footer className="footer">
      <div className="wrap">
        <div className="foot-grid">
          <div>
            <div className="flogo"><LogoMark color="#fff"/><div className="txt">NailMania</div></div>
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
              <li><a onClick={()=>setDrawer("catalog")}>{t("navBrands")}</a></li>
            </ul>
          </div>
          <div>
            <h4>{t("colContact")}</h4>
            <div className="ci"><Icon n="phone" s={18}/><span>+373 68 067 486</span></div>
            <div className="ci"><Icon n="mail" s={18}/><span>nailmania18@gmail.com</span></div>
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
