/* ===== Hero + category pills + delivery banner + category tiles ===== */
import React from 'react'
import { Link } from 'react-router-dom'
import { useShop, Icon, Placeholder } from '../shop.jsx'
import { CATS, HERO_IMG } from '../data.js'

export function Hero(){
  const {t,setDrawer} = useShop();
  return (
    <section className="hero">
      <div className="wrap">
        <div className="hero-grid">
          <div className="hero-main">
            <img className="hero-main-img" src={HERO_IMG[0]} alt="" aria-hidden="true" loading="eager" />
            <div className="copy">
              <span className="hero-kicker">{t("heroKicker")}</span>
              <h1 className="hero-title">{t("heroTitle")}</h1>
              <p className="hero-text">{t("heroText")}</p>
              <div className="hero-cta">
                <button className="btn btn-dark" onClick={()=>setDrawer("catalog")}>
                  {t("heroBtn")} <Icon n="arrow" s={18}/>
                </button>
                <a className="btn btn-ghost" href="#new">{t("heroBtn2")}</a>
              </div>
            </div>
            <span className="deco"></span>
          </div>
          <div className="hero-side">
            <a className="hero-card" href="#summer">
              <Placeholder g={["#1b1b1b","#3a3438"]} ratio="auto" img={HERO_IMG[1]}/>
              <div className="hc-txt">
                <b>{t("secSummer")}</b>
                <span style={{color:"#e9dde2"}}>{t("pillSale")}</span>
              </div>
            </a>
            <a className="hero-card" href="#sale">
              <Placeholder g={["#cfe0df","#eef4f3"]} ratio="auto" img={HERO_IMG[2]}/>
              <div className="hc-txt">
                <b>−30%</b>
                <span>{t("navSale")}</span>
                <div className="pill"><Icon n="spark" s={14} fill/> {t("featured")}</div>
              </div>
            </a>
          </div>
        </div>

        {/* colored category pills (Catalog / New / Sale) */}
        <div className="pills">
          <button className="pillbtn pill-cat" onClick={()=>setDrawer("catalog")}>
            <span className="lines"><i></i><i></i><i></i></span>{t("pillCatalog")}
          </button>
          <a className="pillbtn pill-new" href="#new"><Icon n="spark" s={20} fill/>{t("pillNew")}</a>
          <a className="pillbtn pill-sale" href="#sale"><Icon n="star" s={20} fill/>{t("pillSale")}</a>
        </div>

        {/* free delivery banner */}
        <div className="delivery">
          <div className="bar"><Icon n="truck" s={26}/>{t("topPromo")}</div>
        </div>
      </div>
    </section>
  );
}

export function Categories(){
  const {t,name,setDrawer} = useShop();
  return (
    <section className="section" id="catalog">
      <div className="wrap">
        <div className="sec-head">
          <h2>{t("catsTitle")}</h2>
          <button className="all" onClick={()=>setDrawer("catalog")}>{t("all")} <Icon n="chev" s={16}/></button>
        </div>
        <div className="cats-grid">
          {CATS.map(c=>(
            <Link className="cat-tile" key={c.id} to={"/category/"+c.id}>
              <div className="img"><Placeholder g={c.g} icon={c.icon} ratio="4/3" radius={0} img={c.img} label={name(c)}/></div>
              <div className="cap">{name(c)} <Icon n="arrow" s={16}/></div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
