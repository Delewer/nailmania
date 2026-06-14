/* ===== Brands + About/Delivery + Social + Footer ===== */
import React from 'react'
import { Link } from 'react-router-dom'
import { useShop, Icon, Placeholder } from '../shop.jsx'
import { LogoMark } from './Header.jsx'
import { CATS, CATALOG_BRANDS, ABOUT_IMG } from '../data.js'

export function Brands(){
  const {t} = useShop();
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
          {CATALOG_BRANDS.map(({brand,count})=>(
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
              {["t1","t2","t3"].map(k=>(
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
  const methods = [
    ["card", "payCard", "payCardDesc"],
    ["cash", "payCash", "payCashDesc"],
    ["phone", "payMia", "payMiaDesc"],
  ];
  return (
    <section className="section info-sec" id="plata">
      <div className="wrap">
        <div className="sec-head"><h2>{t("paymentSection")}</h2></div>
        <div className="pay-grid">
          {methods.map(([ic, tk, dk])=>(
            <div className="pay-card" key={tk}>
              <Icon n={ic} s={22}/>
              <div><b>{t(tk)}</b><span>{t(dk)}</span></div>
            </div>
          ))}
        </div>
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
        <div className="info-grid">
          <a className="info-row" href="tel:+37368067486"><Icon n="phone" s={20}/><b>+373 68 067 486</b></a>
          <a className="info-row" href="mailto:nailmania18@gmail.com"><Icon n="mail" s={20}/><b>nailmania18@gmail.com</b></a>
          <a className="info-row" href="https://www.instagram.com/nailmania_md" target="_blank" rel="noreferrer"><Icon n="ig" s={20} fill/><b>@nailmania_md</b></a>
          <div className="info-row"><Icon n="pin" s={20} fill/><b>str. Romană 66/2, Ungheni, Moldova</b></div>
          <div className="info-row"><Icon n="store" s={20}/><b>{t("workHours")}</b></div>
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
              <li><Link to="/#delivery">{t("navDelivery")}</Link></li>
              <li><Link to="/#sale">{t("navSale")}</Link></li>
              <li><Link to="/#new">{t("navNew")}</Link></li>
              <li><a onClick={()=>setDrawer("catalog")}>{t("navBrands")}</a></li>
            </ul>
          </div>
          <div>
            <h4>{t("colContact")}</h4>
            <div className="ci"><Icon n="phone" s={18}/><span>+373 068 067 486</span></div>
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
