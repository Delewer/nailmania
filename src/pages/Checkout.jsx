/* ===== Checkout page ===== */
import React from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useShop, Icon, Placeholder } from '../shop.jsx'

const DELIVERY = [
  { id:"courier", icon:"truck", titleKey:"courier", descKey:"courierDesc", needsAddress:true },
  { id:"pickup",  icon:"store", titleKey:"pickup",  descKey:"pickupDesc",  needsAddress:false }
];
const PAYMENT = [
  { id:"mia",  icon:"spark", titleKey:"payMia",  descKey:"payMiaDesc"  },
  { id:"card", icon:"card",  titleKey:"payCard", descKey:"payCardDesc" },
  { id:"cash", icon:"cash",  titleKey:"payCash", descKey:"payCashDesc" }
];

export default function Checkout(){
  const navigate = useNavigate();
  const { t, name, cart, find, cartTotal, submitOrder, setQty, removeFromCart, allProducts, ensureCatalog, catalogLoading } = useShop();

  const [delivery, setDelivery] = React.useState("");
  const [payment, setPayment]   = React.useState("");
  const [form, setForm] = React.useState({ name:"", phone:"", email:"", city:"", address:"", comment:"" });
  const [agree, setAgree] = React.useState(false);
  const [errors, setErrors] = React.useState({});
  const [done, setDone] = React.useState(null); // order number when placed

  React.useEffect(()=>{ window.scrollTo({top:0}); }, []);
  React.useEffect(()=>{ if(cart.length) ensureCatalog(); }, [cart.length, ensureCatalog]);

  const lines = cart.map(i=>({ ...i, p: find(i.id) })).filter(x=>x.p);
  const discount = lines.reduce((s,l)=> s + (l.p.old>0 ? (l.p.old-l.p.price)*l.q : 0), 0);
  const needsAddress = delivery === "courier";

  const set = (k)=> (e)=> setForm(f=>({ ...f, [k]: e.target.value }));

  const validate = ()=>{
    const er = {};
    if(!delivery) er.delivery = t("reqDelivery");
    if(!payment)  er.payment  = t("reqPayment");
    if(!form.name.trim())  er.name  = t("reqField");
    if(!form.phone.trim()) er.phone = t("reqField");
    if(needsAddress){
      if(!form.city.trim())    er.city    = t("reqField");
      if(!form.address.trim()) er.address = t("reqField");
    }
    setErrors(er);
    return Object.keys(er).length === 0;
  };

  const placeOrder = (e)=>{
    e.preventDefault();
    if(!agree) return;
    if(!validate()) return;
    const order = submitOrder({
      customer: { ...form },
      delivery, deliveryLabel: t(DELIVERY.find(d=>d.id===delivery)?.titleKey || ""),
      payment,  paymentLabel:  t(PAYMENT.find(p=>p.id===payment)?.titleKey || ""),
    });
    setDone(order);
    window.scrollTo({top:0});
  };

  if(done){
    return (
      <div className="wrap page">
        <div className="co-done">
          <div className="tick"><Icon n="check" s={42}/></div>
          <h1>{t("orderSuccess")}</h1>
          <p>{t("orderSuccessText")}</p>
          <div className="ono">{t("orderNo")}: <b>{done.no}</b></div>

          <div className="co-receipt">
            <h3>{t("yourOrder")}</h3>
            <div className="rlines">
              {done.items.map(it=>(
                <div className="rline" key={it.id}>
                  <span className="rn">{it.name} <i>× {it.q}</i></span>
                  <span className="rp">{it.price*it.q} {t("lei")}</span>
                </div>
              ))}
            </div>
            {done.discount>0 && <div className="rrow disc"><span>{t("discountLabel")}</span><b>-{done.discount} {t("lei")}</b></div>}
            <div className="rrow"><span>{t("deliveryLabel")}</span><span>{done.deliveryLabel}</span></div>
            <div className="rrow"><span>{t("paymentSection")}</span><span>{done.paymentLabel}</span></div>
            <div className="rrow grand"><span>{t("total")}</span><b>{done.total} {t("lei")}</b></div>
          </div>

          <div><Link className="btn btn-dark" to="/">{t("continueShopping")}</Link></div>
        </div>
      </div>
    );
  }

  if(cart.length > 0 && lines.length === 0 && (!allProducts.length || catalogLoading)){
    return (
      <div className="wrap page">
        <div className="page-empty">
          <Icon n="bag" s={60}/>
          <h2>{t("catalog")}...</h2>
        </div>
      </div>
    );
  }

  if(lines.length === 0){
    return (
      <div className="wrap page">
        <div className="page-empty">
          <Icon n="bag" s={60}/>
          <h2>{t("emptyCheckout")}</h2>
          <Link className="btn btn-dark" to="/">{t("backHome")}</Link>
        </div>
      </div>
    );
  }

  const field = (key, k, type="text", full=false)=>(
    <div className={"field"+(full?" full":"")+(errors[k]?" err":"")}>
      <label>{t(key)} <span className="req">*</span></label>
      <input type={type} value={form[k]} onChange={set(k)} />
      {errors[k] && <span className="errmsg">{errors[k]}</span>}
    </div>
  );

  return (
    <form className="wrap page" onSubmit={placeOrder} noValidate>
      <nav className="crumbs">
        <Link to="/">{t("home")}</Link><Icon n="chev" s={14}/>
        <span className="cur">{t("checkoutTitle")}</span>
      </nav>
      <h1>{t("checkoutTitle")}</h1>

      <div className="co">
        <div>
          {/* delivery */}
          <div className="co-card">
            <h3>{t("deliverySection")}</h3>
            <div className="co-opts">
              {DELIVERY.map(o=>(
                <button type="button" key={o.id} className={"co-opt"+(delivery===o.id?" on":"")} onClick={()=>setDelivery(o.id)}>
                  <span className="ico"><Icon n={o.icon} s={22}/></span>
                  <span className="ot"><b>{t(o.titleKey)}</b><span>{t(o.descKey)}</span></span>
                  <span className="radio"/>
                </button>
              ))}
            </div>
            {errors.delivery && <span className="errmsg" style={{marginTop:10,display:"block"}}>{errors.delivery}</span>}
            {needsAddress && (
              <div className="co-fields" style={{marginTop:18}}>
                {field("cityLabel","city")}
                {field("addressLabel","address")}
              </div>
            )}
          </div>

          {/* recipient */}
          <div className="co-card">
            <h3>{t("recipient")}</h3>
            <div className="co-fields">
              {field("fullName","name")}
              {field("phone","phone","tel")}
              <div className={"field full"}>
                <label>{t("emailLabel")}</label>
                <input type="email" value={form.email} onChange={set("email")} />
              </div>
            </div>
          </div>

          {/* payment */}
          <div className="co-card">
            <h3>{t("paymentSection")}</h3>
            <div className="co-opts">
              {PAYMENT.map(o=>(
                <button type="button" key={o.id} className={"co-opt"+(payment===o.id?" on":"")} onClick={()=>setPayment(o.id)}>
                  <span className="ico"><Icon n={o.icon} s={22} fill={o.icon==="spark"}/></span>
                  <span className="ot"><b>{t(o.titleKey)}</b><span>{t(o.descKey)}</span></span>
                  <span className="radio"/>
                </button>
              ))}
            </div>
            {errors.payment && <span className="errmsg" style={{marginTop:10,display:"block"}}>{errors.payment}</span>}
          </div>

          {/* comment */}
          <div className="co-card">
            <h3>{t("commentLabel")}</h3>
            <div className="field">
              <textarea placeholder={t("commentPh")} value={form.comment} onChange={set("comment")} />
            </div>
          </div>
        </div>

        {/* order summary */}
        <aside className="co-sum">
          <h3>{t("yourOrder")}</h3>
          <div className="lines nm-scroll">
            {lines.map(l=>(
              <div className="sline" key={l.id}>
                <Placeholder g={l.p.g} icon="bottle" radius={10} img={l.p.img} label={name(l.p)}/>
                <div className="sn">
                  <b>{name(l.p)}</b>
                  <div className="sctrl">
                    <div className="qty">
                      <button type="button" onClick={()=>setQty(l.id,l.q-1)} aria-label="-"><Icon n="minus" s={14}/></button>
                      <span>{l.q}</span>
                      <button type="button" onClick={()=>setQty(l.id,l.q+1)} aria-label="+"><Icon n="plus" s={14}/></button>
                    </div>
                    <span className="sp">{l.p.price*l.q} {t("lei")}</span>
                  </div>
                </div>
                <button type="button" className="srm" onClick={()=>removeFromCart(l.id)} aria-label="remove"><Icon n="trash" s={16}/></button>
              </div>
            ))}
          </div>
          <div className="totrow"><span>{t("itemsLabel")}: {lines.reduce((s,l)=>s+l.q,0)}</span><span>{cartTotal+discount} {t("lei")}</span></div>
          {discount>0 && <div className="totrow disc"><span>{t("discountLabel")}</span><b>-{discount} {t("lei")}</b></div>}
          <div className="totrow"><span>{t("deliveryLabel")}</span><span>{t("freeLabel")}</span></div>
          <div className="totrow grand"><span>{t("total")}</span><b>{cartTotal} {t("lei")}</b></div>

          <label className="co-agree">
            <input type="checkbox" checked={agree} onChange={e=>setAgree(e.target.checked)} />
            <span>{t("agreePre")} <a href="#" onClick={e=>e.preventDefault()}>{t("agreeLink")}</a></span>
          </label>
          <button type="submit" className="co-place" disabled={!agree}>
            <Icon n="check" s={20}/>{t("placeOrder")}
          </button>
        </aside>
      </div>
    </form>
  );
}
