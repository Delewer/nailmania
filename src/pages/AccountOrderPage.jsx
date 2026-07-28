import React from "react";
import { Link, useParams } from "react-router-dom";
import { accountText, orderStatusText } from "../account-copy.js";
import { planRepeatOrder } from "../account-utils.js";
import { useAuth } from "../auth.jsx";
import { ApiErrorNotice, ProtectedAccount } from "../components/AccountUi.jsx";
import { CatalogUnavailable } from "../components/CatalogState.jsx";
import { Icon, useShop } from "../shop.jsx";
import { formatDate, formatMoney } from "./AccountPage.jsx";

function OrderContent() {
  const { id } = useParams();
  const auth = useAuth();
  const {
    lang, cart, addItemsToCart, ensureCatalog, catalogError,
  } = useShop();
  const [order, setOrder] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [repeatBusy, setRepeatBusy] = React.useState(false);
  const [repeatResult, setRepeatResult] = React.useState(null);

  const load = React.useCallback(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    auth.loadOrder(id, { signal: controller.signal }).then((payload) => setOrder(payload.order))
      .catch((caught) => { if (caught?.name !== "AbortError") setError(caught); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [auth.loadOrder, id]);
  React.useEffect(() => load(), [load]);

  const repeatOrder = async () => {
    if (!order || repeatBusy) return;
    setRepeatBusy(true);
    setRepeatResult(null);
    try {
      const products = await ensureCatalog({ force: true });
      if (!products.length) {
        setRepeatResult({ type: "error", message: accountText(lang, "catalogUnavailable") });
        return;
      }
      const plan = planRepeatOrder(order.items, products, cart);
      if (!plan.entries.length) {
        setRepeatResult({ type: "error", message: accountText(lang, "repeatUnavailable") });
        return;
      }
      addItemsToCart(plan.entries,{source:'repeat_order'});
      const affected = plan.unavailable.length + plan.adjusted.length;
      setRepeatResult({
        type: affected ? "warning" : "success",
        message: accountText(lang, affected ? "repeatPartial" : "repeatAdded"),
        affected,
      });
    } catch {
      setRepeatResult({ type: "error", message: accountText(lang, "catalogUnavailable") });
    } finally { setRepeatBusy(false); }
  };

  if (loading) return <div className="account-order-loading" role="status" aria-busy="true" aria-label={accountText(lang, "loading")} />;
  if (error) return <section className="account-card"><ApiErrorNotice error={error} language={lang} /><button className="account-secondary" type="button" onClick={load}>{accountText(lang, "retry")}</button></section>;
  if (!order) return null;
  return (
    <>
      <nav className="crumbs"><Link to="/account">{accountText(lang, "account")}</Link><Icon n="chev" s={14} /><span className="cur">{order.no}</span></nav>
      <header className="order-detail-head">
        <div><span>{accountText(lang, "order")}</span><h1>{order.no}</h1><p>{formatDate(order.createdAt, lang)}</p></div>
        <span className={`order-status status-${order.status}`}>{orderStatusText(lang, order.status)}</span>
      </header>
      {catalogError && <div className="account-catalog-warning"><CatalogUnavailable /></div>}
      <div className="order-detail-grid">
        <section className="account-card order-items-card">
          <h2>{accountText(lang, "orderItems")}</h2>
          <div className="order-detail-items">
            {order.items.map((item) => (
              <div className="order-detail-item" key={item.id}>
                <div><strong>{item.name}</strong><span>{item.brand} · {item.sku}</span>{item.returnedQuantity > 0 && <span className="returned-line">{accountText(lang, "returnedQuantity", { count: item.returnedQuantity })}</span>}</div>
                <span>× {item.quantity}</span>
                <b>{formatMoney(item.lineTotal, lang)}</b>
              </div>
            ))}
          </div>
          <dl className="order-totals">
            <div><dt>{accountText(lang, "orderItems")}</dt><dd>{formatMoney(order.itemsSubtotal, lang)}</dd></div>
            {order.catalogDiscount > 0 && <div><dt>{accountText(lang, "catalogDiscount")}</dt><dd>−{formatMoney(order.catalogDiscount, lang)}</dd></div>}
            {order.promoDiscount > 0 && <div><dt>{accountText(lang, "promoDiscount", { code: order.promoCode || "—" })}</dt><dd>−{formatMoney(order.promoDiscount, lang)}</dd></div>}
            <div><dt>{accountText(lang, "delivery")}</dt><dd>{formatMoney(order.deliveryFee, lang)}</dd></div>
            <div className="grand"><dt>{accountText(lang, "orderTotal")}</dt><dd>{formatMoney(order.total, lang)}</dd></div>
          </dl>
          <button className="account-primary repeat-order" type="button" onClick={repeatOrder} disabled={repeatBusy}>
            <Icon n="bag" s={18} />{repeatBusy ? accountText(lang, "repeatingOrder") : accountText(lang, "repeatOrder")}
          </button>
          {repeatResult && <div className={`auth-alert ${repeatResult.type}`} role="status">
            <span>{repeatResult.message}</span>
            {repeatResult.affected > 0 && <small>{accountText(lang, "itemUnavailableCount", { count: repeatResult.affected })}</small>}
            {repeatResult.type !== "error" && <Link to="/checkout">{accountText(lang, "goCheckout")}</Link>}
          </div>}
        </section>
        <aside className="order-detail-side">
          <section className="account-card compact-card">
            <h2>{accountText(lang, "recipient")}</h2>
            <p><strong>{order.customer.name}</strong></p><p>{order.customer.phone}</p>
            {order.customer.email && <p>{order.customer.email}</p>}
            {order.customer.city && <p>{order.customer.city}, {order.customer.address}</p>}
            {order.customer.comment && <small>{order.customer.comment}</small>}
          </section>
          <section className="account-card compact-card">
            <h2>{accountText(lang, "delivery")}</h2><p>{order.deliveryLabel}</p>
            <h2>{accountText(lang, "payment")}</h2><p>{order.paymentLabel}</p>
          </section>
          <section className="account-card compact-card">
            <h2>{accountText(lang, "statusHistory")}</h2>
            <ol className="status-history">
              {order.history.map((entry) => <li key={entry.id}><span /><div><strong>{orderStatusText(lang, entry.toStatus)}</strong><small>{formatDate(entry.createdAt, lang)}</small></div></li>)}
            </ol>
          </section>
        </aside>
      </div>
    </>
  );
}

export default function AccountOrderPage() {
  const { lang } = useShop();
  return <ProtectedAccount language={lang}><div className="wrap page account-page order-detail-page"><OrderContent /></div></ProtectedAccount>;
}
