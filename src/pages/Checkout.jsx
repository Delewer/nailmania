/* ===== Checkout page ===== */
import React from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useShop, Icon, Placeholder } from '../shop.jsx'
import { CatalogUnavailable } from '../components/CatalogState.jsx'
import { calculateDeliveryFee, COURIER_DELIVERY_FEE } from '../../shared/order-rules.js'
import { useAuth } from '../auth.jsx'
import { TURNSTILE_CONFIG, TurnstileWidget } from '../components/TurnstileWidget.jsx'
import { validatePromoRequest } from '../promo-api.js'
import { trackProductEvent } from '../product-analytics.js'
import { getOrCreateOrderAttemptKey, startNewOrderAttemptKey } from '../order-attempt.js'
import { createOrderQuote, normalizeExpectedOrderQuote } from '../../shared/order-quote.js'
import { cartLineLimit } from '../cart-quantity.js'
import {
  MOLDOVA_COUNTRY_CODE,
  moldovaLocalPhone,
  normalizeMoldovaPhone,
  sanitizeMoldovaPhoneInput,
} from '../../shared/moldova-phone.js'

const DELIVERY = [
  { id:"courier", icon:"truck", titleKey:"courier", descKey:"courierDesc", needsAddress:true },
  { id:"pickup",  icon:"store", titleKey:"pickup",  descKey:"pickupDesc",  needsAddress:false }
];
const PAYMENT = [
  { id:"mia",  icon:"spark", titleKey:"payMia",  descKey:"payMiaDesc"  },
  { id:"card", icon:"card",  titleKey:"payCard", descKey:"payCardDesc" },
  { id:"cash", icon:"cash",  titleKey:"payCash", descKey:"payCashDesc" }
];
const ORDER_UNAVAILABLE_CODES = new Set([
  "ORDER_API_UNAVAILABLE",
  "DB_NOT_CONFIGURED",
  "LEGACY_ORDER_ENDPOINT_DISABLED",
]);
const PROMO_INVALID_CODES = new Set(["INVALID_PROMO_CODE", "PROMO_NOT_FOUND", "PROMO_INACTIVE", "PROMO_NOT_STARTED", "PROMO_EXPIRED"]);
const PROMO_LIMIT_CODES = new Set(["PROMO_TOTAL_LIMIT_REACHED", "PROMO_USER_LIMIT_REACHED"]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Checkout(){
  const navigate = useNavigate();
  const { lang, t, name, cart, find, cartTotal, submitOrder, setQty, removeFromCart, allProducts, ensureCatalog, catalogLoading, catalogLoaded, catalogError } = useShop();
  const { user, defaultAddress } = useAuth();

  const [delivery, setDelivery] = React.useState("");
  const [payment, setPayment]   = React.useState("");
  const [form, setForm] = React.useState({ name:"", phone:"", email:"", city:"", address:"", comment:"" });
  const [agree, setAgree] = React.useState(false);
  const [errors, setErrors] = React.useState({});
  const [done, setDone] = React.useState(null); // order number when placed
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState("");
  const [promoInput, setPromoInput] = React.useState("");
  const [appliedPromo, setAppliedPromo] = React.useState(null);
  const [promoBusy, setPromoBusy] = React.useState(false);
  const [promoError, setPromoError] = React.useState("");
  const [turnstileToken, setTurnstileToken] = React.useState("");
  const [turnstileResetKey, setTurnstileResetKey] = React.useState(0);
  const [serverQuote, setServerQuote] = React.useState(null);
  const [orderAttemptKey,setOrderAttemptKey] = React.useState(()=>getOrCreateOrderAttemptKey());
  const [attemptConflict,setAttemptConflict] = React.useState(false);
  const dirtyFields = React.useRef(new Set());
  const autofilledFields = React.useRef(new Set());
  const checkoutEventSent = React.useRef(false);

  React.useEffect(()=>{ window.scrollTo({top:0}); }, []);
  React.useEffect(()=>{ if(cart.length) ensureCatalog(); }, [cart.length, ensureCatalog]);
  React.useEffect(()=>{
    if(!user) return;
    const suggested = {
      name:user.name || "",
      phone:moldovaLocalPhone(defaultAddress?.phone) || moldovaLocalPhone(user.phone),
      email:user.email || "",
      city:defaultAddress?.city || "",
      address:defaultAddress?.address || "",
      comment:defaultAddress?.comment || "",
    };
    setForm(current=>{
      let changed=false;
      const next={...current};
      for(const [key,value] of Object.entries(suggested)){
        if(!dirtyFields.current.has(key) && value && (!current[key] || autofilledFields.current.has(key)) && current[key]!==value){
          next[key]=value;
          autofilledFields.current.add(key);
          changed=true;
        }
      }
      return changed ? next : current;
    });
  },[defaultAddress,user]);

  const lines = cart.map(i=>({ ...i, p: find(i.id) })).filter(x=>x.p);
  const localDiscount = lines.reduce((s,l)=> s + (l.p.old>l.p.price ? (l.p.old-l.p.price)*l.q : 0), 0);
  const cartSignature = cart.map(item=>`${item.id}:${item.q}`).sort().join('|');
  const linePriceSignature = lines.map(line=>`${line.id}:${line.q}:${line.p.price}:${line.p.old || 0}`).sort().join('|');
  const localMerchandiseSubtotal = appliedPromo?.cartSignature === cartSignature
    ? appliedPromo.merchandiseSubtotal
    : cartTotal;
  const localPromoDiscount = appliedPromo?.cartSignature === cartSignature ? appliedPromo.discountAmount : 0;
  const needsAddress = delivery === "courier";
  const localDeliveryFee = calculateDeliveryFee(delivery, localMerchandiseSubtotal);
  const localOrderTotal = Math.max(0, localMerchandiseSubtotal + localDeliveryFee - localPromoDiscount);
  let localQuote = null;
  if(lines.length){
    localQuote = createOrderQuote({
      items:lines.map(line=>({
        productKey:line.id,
        quantity:line.q,
        unitPrice:line.p.price,
        listPrice:line.p.old>line.p.price ? line.p.old : line.p.price,
        lineTotal:line.p.price*line.q,
      })),
      itemsSubtotal:localMerchandiseSubtotal,
      catalogDiscount:localDiscount,
      deliveryFee:localDeliveryFee,
      promoCode:appliedPromo?.cartSignature === cartSignature ? appliedPromo.code : null,
      promoDiscount:localPromoDiscount,
      totalAmount:localOrderTotal,
    });
  }
  const displayedQuote = serverQuote || localQuote;
  const quoteLines = new Map((displayedQuote?.items || []).map(item=>[item.productKey,item]));
  const merchandiseSubtotal = displayedQuote?.itemsSubtotal ?? localMerchandiseSubtotal;
  const discount = displayedQuote?.catalogDiscount ?? localDiscount;
  const promoDiscount = displayedQuote?.promoDiscount ?? localPromoDiscount;
  const deliveryFee = displayedQuote?.deliveryFee ?? localDeliveryFee;
  const orderTotal = displayedQuote?.totalAmount ?? localOrderTotal;
  const deliveryAmountLabel = delivery ? (deliveryFee ? `+${deliveryFee} ${t("lei")}` : t("freeLabel")) : "—";

  React.useEffect(()=>{
    if(checkoutEventSent.current || !lines.length) return;
    checkoutEventSent.current=true;
    trackProductEvent('checkout_started',{
      language:lang,
      source:'checkout',
      itemCount:lines.reduce((sum,line)=>sum+line.q,0),
      value:merchandiseSubtotal,
    });
  },[lang,lines,merchandiseSubtotal]);

  React.useEffect(()=>{
    if(appliedPromo && appliedPromo.cartSignature !== cartSignature){
      setAppliedPromo(null);
      setPromoError(t("promoCartChanged"));
    }
  },[appliedPromo,cartSignature,t]);

  // A quote returned after a conflict remains visible for explicit
  // confirmation. Any subsequent cart, delivery, promo or catalog-price
  // change discards it and creates a fresh displayed snapshot.
  React.useEffect(()=>{
    setServerQuote(null);
  },[cartSignature,delivery,linePriceSignature,appliedPromo?.code]);

  const set = (k)=> (e)=>{
    dirtyFields.current.add(k);
    autofilledFields.current.delete(k);
    setForm(f=>({ ...f, [k]: e.target.value }));
    setErrors(current=> current[k] ? {...current,[k]:undefined} : current);
  };
  const setPhone = (event)=>{
    dirtyFields.current.add('phone');
    autofilledFields.current.delete('phone');
    setForm(current=>({...current,phone:sanitizeMoldovaPhoneInput(event.target.value)}));
    setErrors(current=>current.phone ? {...current,phone:undefined} : current);
  };
  const selectOption = (setter,key,value)=>{
    setter(value);
    setErrors(current=> current[key] ? {...current,[key]:undefined} : current);
  };

  const promoMessage = React.useCallback((error)=>{
    if(error?.code === "PROMO_LOGIN_REQUIRED") return t("promoLoginRequired");
    if(PROMO_LIMIT_CODES.has(error?.code)) return t("promoLimitReached");
    if(error?.code === "PROMO_MIN_ORDER") return t("promoMinOrder");
    if(error?.code === "PROMO_NOT_APPLICABLE") return t("promoNotApplicable");
    if(error?.code === "PROMO_CHANGED") return t("promoChanged");
    if(PROMO_INVALID_CODES.has(error?.code)) return t("promoInvalid");
    return t("promoUnavailable");
  },[t]);

  const applyPromo = async ()=>{
    const code = promoInput.trim().toUpperCase();
    if(!code || promoBusy) return;
    setPromoBusy(true);
    setPromoError("");
    try{
      const promo = await validatePromoRequest({
        code,
        items:cart.map(item=>({productKey:item.id,quantity:item.q})),
      });
      setPromoInput(promo.code);
      setAppliedPromo({...promo,cartSignature});
    }catch(error){
      setAppliedPromo(null);
      setPromoError(promoMessage(error));
    }finally{
      setPromoBusy(false);
    }
  };

  const removePromo = ()=>{
    setAppliedPromo(null);
    setPromoInput("");
    setPromoError("");
  };

  const validate = ()=>{
    const er = {};
    if(!delivery) er.delivery = t("reqDelivery");
    if(!payment)  er.payment  = t("reqPayment");
    if(!form.name.trim())  er.name  = t("reqField");
    if(!form.phone.trim()) er.phone = t("reqField");
    else if(!normalizeMoldovaPhone(form.phone)) er.phone = t("invalidCheckoutPhone");
    if(form.email.trim() && !EMAIL_PATTERN.test(form.email.trim())) er.email = t("invalidCheckoutEmail");
    if(!turnstileToken) er.turnstile = t("orderVerifyHuman");
    if(needsAddress){
      if(!form.city.trim())    er.city    = t("reqField");
      if(!form.address.trim()) er.address = t("reqField");
    }
    setErrors(er);
    return Object.keys(er).length === 0;
  };

  const placeOrder = async (e)=>{
    e.preventDefault();
    if(!agree || submitting) return;
    if(!validate()) return;
    setSubmitting(true);
    setSubmitError("");
    setAttemptConflict(false);
    try{
      const order = await submitOrder({
        customer: { ...form, phone:normalizeMoldovaPhone(form.phone) },
        delivery, deliveryLabel: t(DELIVERY.find(d=>d.id===delivery)?.titleKey || ""),
        deliveryFee,
        total: orderTotal,
        payment,  paymentLabel:  t(PAYMENT.find(p=>p.id===payment)?.titleKey || ""),
        promoCode: appliedPromo?.cartSignature === cartSignature ? appliedPromo.code : "",
        turnstileToken,
        idempotencyKey:orderAttemptKey,
        expectedQuote:displayedQuote,
      });
      setDone(order);
      window.scrollTo({top:0});
    }catch(error){
      if(error?.code==="ORDER_QUOTE_CHANGED" && error?.details?.currentQuote){
        try{
          setServerQuote(normalizeExpectedOrderQuote(error.details.currentQuote));
          setSubmitError(t("orderQuoteChanged"));
        }catch{
          setSubmitError(t("orderSubmitError"));
        }
      }else if(error?.code==="INSUFFICIENT_STOCK" || error?.code==="PRODUCT_NOT_FOUND"){
        setSubmitError(t("orderStockError"));
      }else if(error?.code?.startsWith?.("PROMO_") || error?.code === "INVALID_PROMO_CODE"){
        setAppliedPromo(null);
        setPromoError(promoMessage(error));
        setSubmitError(promoMessage(error));
      }else if(error?.code?.startsWith?.("HUMAN_VERIFICATION_")){
        setSubmitError(t("orderVerifyHuman"));
      }else if(ORDER_UNAVAILABLE_CODES.has(error?.code)){
        setSubmitError(t("orderUnavailableError"));
      }else if(error?.code === "IDEMPOTENCY_KEY_REUSED"){
        setSubmitError(t("orderAttemptConflict"));
        setAttemptConflict(true);
      }else{
        setSubmitError(t("orderSubmitError"));
      }
      setTurnstileResetKey(value=>value+1);
    }finally{
      setSubmitting(false);
    }
  };

  const beginNewAttempt = ()=>{
    if(!window.confirm(t("newOrderAttemptConfirm"))) return;
    setOrderAttemptKey(startNewOrderAttemptKey());
    setAttemptConflict(false);
    setSubmitError("");
    setTurnstileResetKey(value=>value+1);
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
            {done.catalogDiscount>0 && <div className="rrow disc"><span>{t("discountLabel")}</span><b>-{done.catalogDiscount} {t("lei")}</b></div>}
            {done.promoDiscount>0 && <div className="rrow disc"><span>{t("promoDiscountLabel")}{done.promoCode ? ` · ${done.promoCode}` : ""}</span><b>-{done.promoDiscount} {t("lei")}</b></div>}
            <div className="rrow"><span>{t("deliveryLabel")}</span><span>{done.deliveryFee ? `${done.deliveryLabel} +${done.deliveryFee} ${t("lei")}` : t("freeLabel")}</span></div>
            <div className="rrow"><span>{t("paymentSection")}</span><span>{done.paymentLabel}</span></div>
            <div className="rrow grand"><span>{t("total")}</span><b>{done.total} {t("lei")}</b></div>
          </div>

          <div><Link className="btn btn-dark" to="/">{t("continueShopping")}</Link></div>
        </div>
      </div>
    );
  }

  if(cart.length > 0 && lines.length === 0 && catalogError){
    return <div className="wrap page"><CatalogUnavailable/></div>;
  }

  if(cart.length > 0 && lines.length === 0 && (!catalogLoaded || !allProducts.length || catalogLoading)){
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

  const field = (key, k, type="text", full=false)=>{
    const id = `checkout-${k}`;
    const errorId = `${id}-error`;
    const autoComplete = {name:"name",phone:"tel",city:"address-level2",address:"street-address"}[k];
    return (
    <div className={"field"+(full?" full":"")+(errors[k]?" err":"")}>
      <label htmlFor={id}>{t(key)} <span className="req" aria-hidden="true">*</span></label>
      <input id={id} name={k} type={type} value={form[k]} onChange={set(k)} autoComplete={autoComplete} aria-invalid={Boolean(errors[k])} aria-describedby={errors[k]?errorId:undefined}/>
      {errors[k] && <span className="errmsg" id={errorId} role="alert">{errors[k]}</span>}
    </div>
    );
  };

  const phoneErrorId = 'checkout-phone-error';
  const phoneField = (
    <div className={'field'+(errors.phone?' err':'')}>
      <label htmlFor="checkout-phone">{t('phone')} <span className="req" aria-hidden="true">*</span></label>
      <div className="co-phone-input">
        <span id="checkout-phone-prefix">{MOLDOVA_COUNTRY_CODE}</span>
        <input
          id="checkout-phone"
          name="phone"
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          value={form.phone}
          onChange={setPhone}
          maxLength={16}
          pattern="[1-9][0-9]{7}"
          placeholder="60123456"
          aria-invalid={Boolean(errors.phone)}
          aria-describedby={`checkout-phone-prefix${errors.phone?` ${phoneErrorId}`:''}`}
        />
      </div>
      {errors.phone && <span className="errmsg" id={phoneErrorId} role="alert">{errors.phone}</span>}
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
          <fieldset className="co-card co-fieldset" aria-describedby={errors.delivery?"checkout-delivery-error":undefined}>
            <legend>{t("deliverySection")}</legend>
            <div className="co-opts">
              {DELIVERY.map(o=>(
                <label key={o.id} className={"co-opt"+(delivery===o.id?" on":"")}>
                  <input className="co-native-option" type="radio" name="delivery" value={o.id} checked={delivery===o.id} onChange={()=>selectOption(setDelivery,"delivery",o.id)}/>
                  <span className="ico"><Icon n={o.icon} s={22}/></span>
                  <span className="ot">
                    <b>{t(o.titleKey)}</b>
                    <span>{t(o.descKey)}</span>
                    {o.id === "courier" && <em>{calculateDeliveryFee(o.id, merchandiseSubtotal) ? `+${COURIER_DELIVERY_FEE} ${t("lei")}` : t("freeLabel")}</em>}
                  </span>
                  <span className="radio" aria-hidden="true"/>
                </label>
              ))}
            </div>
            {errors.delivery && <span className="errmsg" id="checkout-delivery-error" role="alert" style={{marginTop:10,display:"block"}}>{errors.delivery}</span>}
            {needsAddress && (
              <div className="co-fields" style={{marginTop:18}}>
                {field("cityLabel","city")}
                {field("addressLabel","address")}
              </div>
            )}
          </fieldset>

          {/* recipient */}
          <div className="co-card">
            <h3>{t("recipient")}</h3>
            <div className="co-fields">
              {field("fullName","name")}
              {phoneField}
              <div className={"field full"+(errors.email?" err":"")}>
                <label htmlFor="checkout-email">{t("emailLabel")}</label>
                <input id="checkout-email" name="email" type="email" value={form.email} onChange={set("email")} autoComplete="email" aria-invalid={Boolean(errors.email)} aria-describedby={errors.email?"checkout-email-error":undefined}/>
                {errors.email && <span className="errmsg" id="checkout-email-error" role="alert">{errors.email}</span>}
              </div>
            </div>
          </div>

          {/* payment */}
          <fieldset className="co-card co-fieldset" aria-describedby={errors.payment?"checkout-payment-error":undefined}>
            <legend>{t("paymentSection")}</legend>
            <div className="co-opts">
              {PAYMENT.map(o=>(
                <label key={o.id} className={"co-opt"+(payment===o.id?" on":"")}>
                  <input className="co-native-option" type="radio" name="payment" value={o.id} checked={payment===o.id} onChange={()=>selectOption(setPayment,"payment",o.id)}/>
                  <span className="ico"><Icon n={o.icon} s={22} fill={o.icon==="spark"}/></span>
                  <span className="ot"><b>{t(o.titleKey)}</b><span>{t(o.descKey)}</span></span>
                  <span className="radio" aria-hidden="true"/>
                </label>
              ))}
            </div>
            {errors.payment && <span className="errmsg" id="checkout-payment-error" role="alert" style={{marginTop:10,display:"block"}}>{errors.payment}</span>}
          </fieldset>

          {/* comment */}
          <div className="co-card">
            <h3 id="checkout-comment-label">{t("commentLabel")}</h3>
            <div className="field">
              <textarea id="checkout-comment" name="comment" aria-labelledby="checkout-comment-label" placeholder={t("commentPh")} value={form.comment} onChange={set("comment")} maxLength={1000}/>
            </div>
          </div>
        </div>

        {/* order summary */}
        <aside className="co-sum">
          <h3>{t("yourOrder")}</h3>
          <div className="lines nm-scroll">
            {lines.map(l=>{
              const atLineLimit = l.q>=cartLineLimit(l.p);
              return <div className="sline" key={l.id}>
                <Placeholder g={l.p.g} icon="bottle" radius={10} img={l.p.img} label={name(l.p)}/>
                <div className="sn">
                  <b>{name(l.p)}</b>
                  <div className="sctrl">
                    <div className="qty">
                      <button type="button" onClick={()=>setQty(l.id,l.q-1)} aria-label={t("decreaseQty")}><Icon n="minus" s={14}/></button>
                      <span aria-live="polite">{l.q}</span>
                      <button type="button" onClick={()=>setQty(l.id,l.q+1)} disabled={atLineLimit} aria-label={atLineLimit?t("stockLimitReached"):t("increaseQty")}><Icon n="plus" s={14}/></button>
                    </div>
                    <span className="sp">{quoteLines.get(l.id)?.lineTotal ?? l.p.price*l.q} {t("lei")}</span>
                  </div>
                </div>
                <button type="button" className="srm" onClick={()=>removeFromCart(l.id)} aria-label={t("removeItem")}><Icon n="trash" s={16}/></button>
              </div>
            })}
          </div>
          <div className="co-promo">
            <label htmlFor="checkout-promo">{t("promoCodeLabel")}</label>
            <div className="co-promo-row">
              <input
                id="checkout-promo"
                value={promoInput}
                onChange={(event)=>{ setPromoInput(event.target.value.toUpperCase()); setPromoError(""); }}
                onKeyDown={(event)=>{ if(event.key === "Enter"){ event.preventDefault(); applyPromo(); } }}
                placeholder={t("promoCodePlaceholder")}
                autoComplete="off"
                maxLength={32}
                disabled={promoBusy || Boolean(appliedPromo)}
              />
              {appliedPromo
                ? <button type="button" className="co-promo-remove" onClick={removePromo}>{t("removePromo")}</button>
                : <button type="button" onClick={applyPromo} disabled={promoBusy || !promoInput.trim()}>{promoBusy ? "…" : t("applyPromo")}</button>}
            </div>
            {appliedPromo && <span className="co-promo-success" role="status"><Icon n="check" s={15}/>{t("promoApplied")} · {appliedPromo.code}</span>}
            {promoError && <span className="errmsg" role="alert">{promoError}</span>}
          </div>
          <div className="totrow"><span>{t("itemsLabel")}: {lines.reduce((s,l)=>s+l.q,0)}</span><span>{merchandiseSubtotal+discount} {t("lei")}</span></div>
          {discount>0 && <div className="totrow disc"><span>{t("discountLabel")}</span><b>-{discount} {t("lei")}</b></div>}
          {promoDiscount>0 && <div className="totrow disc"><span>{t("promoDiscountLabel")} · {displayedQuote?.promoCode || appliedPromo?.code}</span><b>-{promoDiscount} {t("lei")}</b></div>}
          <div className="totrow"><span>{t("deliveryLabel")}</span><span>{deliveryAmountLabel}</span></div>
          <div className="totrow grand"><span>{t("total")}</span><b>{orderTotal} {t("lei")}</b></div>
          {(appliedPromo || serverQuote) && <div className="co-server-total" role="status"><Icon n="check" s={14}/>{t("promoServerPrice")}</div>}

          <TurnstileWidget action="order" language={lang} onToken={setTurnstileToken} resetKey={turnstileResetKey}/>
          {errors.turnstile && <span className="errmsg" role="alert" style={{display:"block",marginBottom:10}}>{errors.turnstile}</span>}
          <label className="co-agree">
            <input type="checkbox" checked={agree} onChange={e=>setAgree(e.target.checked)} />
            <span>{t("agreePre")}</span>
          </label>
          {submitError && <span className="errmsg" role="alert" style={{display:"block",marginBottom:10}}>{submitError}</span>}
          {attemptConflict && <button type="button" className="co-new-attempt" onClick={beginNewAttempt}>{t("newOrderAttempt")}</button>}
          <button type="submit" className="co-place" disabled={!agree || submitting || !turnstileToken || !TURNSTILE_CONFIG.configured}>
            <Icon n="check" s={20}/>{submitting?t("placingOrder"):t("placeOrder")}
          </button>
        </aside>
      </div>
    </form>
  );
}
