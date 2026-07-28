import React from "react";
import { Link } from "react-router-dom";
import { accountText, orderStatusText } from "../account-copy.js";
import { useAuth } from "../auth.jsx";
import { ApiErrorNotice, FormField, ProtectedAccount, SuccessNotice } from "../components/AccountUi.jsx";
import { Icon } from "../shop.jsx";
import { useShop } from "../shop.jsx";

const localeFor = (language) => language === "ru" ? "ru-MD" : "ro-MD";
const formatMoney = (value, language) => `${new Intl.NumberFormat(localeFor(language), { maximumFractionDigits: 0 }).format(Number(value || 0))} MDL`;
const formatDate = (value, language) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(localeFor(language), {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
};
const ORDER_STATUSES = ["pending", "confirmed", "processing", "ready", "shipped", "completed", "cancelled", "returned"];

function ProfileCard() {
  const { lang } = useShop();
  const auth = useAuth();
  const [form, setForm] = React.useState(() => ({ name: auth.user.name || "", phone: auth.user.phone || "" }));
  const [error, setError] = React.useState(null);
  const [success, setSuccess] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState({});
  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault();
    const nextErrors = {};
    if (form.name.trim().length < 2) nextErrors.name = accountText(lang, "required");
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    setBusy(true);
    setError(null);
    setSuccess("");
    try {
      await auth.updateProfile({ name: form.name, phone: form.phone });
      setSuccess(accountText(lang, "profileSaved"));
    } catch (caught) { setError(caught); }
    finally { setBusy(false); }
  };
  return (
    <section className="account-card" id="profile" aria-labelledby="profile-title">
      <div className="account-card-head">
        <div><h2 id="profile-title">{accountText(lang, "profile")}</h2><p>{accountText(lang, "profileLead")}</p></div>
      </div>
      <ApiErrorNotice error={error} language={lang} />
      <SuccessNotice>{success}</SuccessNotice>
      <form className="account-form-grid" onSubmit={submit} noValidate>
        <FormField label={accountText(lang, "fullName")} error={errors.name}>
          <input value={form.name} onChange={update("name")} autoComplete="name" required />
        </FormField>
        <FormField label={accountText(lang, "phone")}>
          <input type="tel" value={form.phone} onChange={update("phone")} autoComplete="tel" />
        </FormField>
        <FormField label={accountText(lang, "email")}>
          <input type="email" value={auth.user.email} disabled readOnly />
        </FormField>
        <div className="account-form-actions"><button className="account-primary" type="submit" disabled={busy}>{busy ? accountText(lang, "saving") : accountText(lang, "save")}</button></div>
      </form>
    </section>
  );
}

const blankAddress = { recipientName: "", phone: "", city: "", address: "", comment: "", isDefault: false };

function AddressEditor({ initial, onCancel, onSaved }) {
  const { lang } = useShop();
  const auth = useAuth();
  const [form, setForm] = React.useState(() => initial ? {
    recipientName: initial.recipientName,
    phone: initial.phone,
    city: initial.city,
    address: initial.address,
    comment: initial.comment || "",
    isDefault: Boolean(initial.isDefault),
  } : { ...blankAddress, recipientName: auth.user.name || "", phone: auth.user.phone || "" });
  const [errors, setErrors] = React.useState({});
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const update = (key) => (event) => setForm((current) => ({
    ...current,
    [key]: event.target.type === "checkbox" ? event.target.checked : event.target.value,
  }));
  const submit = async (event) => {
    event.preventDefault();
    const nextErrors = {};
    for (const key of ["recipientName", "phone", "city", "address"]) {
      if (!String(form[key]).trim()) nextErrors[key] = accountText(lang, "required");
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    setBusy(true);
    setError(null);
    try {
      if (initial) await auth.updateAddress(initial.id, form);
      else await auth.createAddress(form);
      onSaved();
    } catch (caught) { setError(caught); }
    finally { setBusy(false); }
  };
  return (
    <form className="address-editor" onSubmit={submit} noValidate>
      <h3>{accountText(lang, initial ? "editAddress" : "addAddress")}</h3>
      <ApiErrorNotice error={error} language={lang} />
      <div className="account-form-grid">
        <FormField label={accountText(lang, "recipientName")} error={errors.recipientName}>
          <input value={form.recipientName} onChange={update("recipientName")} autoComplete="name" required />
        </FormField>
        <FormField label={accountText(lang, "phone")} error={errors.phone}>
          <input type="tel" value={form.phone} onChange={update("phone")} autoComplete="tel" required />
        </FormField>
        <FormField label={accountText(lang, "city")} error={errors.city}>
          <input value={form.city} onChange={update("city")} autoComplete="address-level2" required />
        </FormField>
        <FormField label={accountText(lang, "address")} error={errors.address}>
          <input value={form.address} onChange={update("address")} autoComplete="street-address" required />
        </FormField>
        <FormField className="wide" label={accountText(lang, "addressComment")}>
          <textarea value={form.comment} onChange={update("comment")} />
        </FormField>
      </div>
      <label className="account-check"><input type="checkbox" checked={form.isDefault} onChange={update("isDefault")} disabled={Boolean(initial?.isDefault)} /> {accountText(lang, "defaultAddress")}</label>
      <div className="account-form-actions">
        <button type="button" className="account-secondary" onClick={onCancel} disabled={busy}>{accountText(lang, "cancel")}</button>
        <button type="submit" className="account-primary" disabled={busy}>{busy ? accountText(lang, "saving") : accountText(lang, "save")}</button>
      </div>
    </form>
  );
}

function AddressesCard() {
  const { lang } = useShop();
  const auth = useAuth();
  const [editing, setEditing] = React.useState(null);
  const [adding, setAdding] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [success, setSuccess] = React.useState("");
  const [busyId, setBusyId] = React.useState("");
  const closeEditor = () => { setEditing(null); setAdding(false); };
  const saved = () => { closeEditor(); setSuccess(accountText(lang, "addressSaved")); };
  const makeDefault = async (address) => {
    setBusyId(address.id); setError(null); setSuccess("");
    try { await auth.updateAddress(address.id, { isDefault: true }); setSuccess(accountText(lang, "addressSaved")); }
    catch (caught) { setError(caught); }
    finally { setBusyId(""); }
  };
  const remove = async (address) => {
    if (!window.confirm(accountText(lang, "confirmDeleteAddress"))) return;
    setBusyId(address.id); setError(null); setSuccess("");
    try { await auth.deleteAddress(address.id); setSuccess(accountText(lang, "addressDeleted")); }
    catch (caught) { setError(caught); }
    finally { setBusyId(""); }
  };
  return (
    <section className="account-card" id="addresses" aria-labelledby="addresses-title">
      <div className="account-card-head">
        <div><h2 id="addresses-title">{accountText(lang, "addresses")}</h2><p>{accountText(lang, "addressesLead")}</p></div>
        {!adding && !editing && <button className="account-secondary" type="button" onClick={() => { setAdding(true); setSuccess(""); }}><Icon n="plus" s={17} />{accountText(lang, "addAddress")}</button>}
      </div>
      <ApiErrorNotice error={error || auth.addressesError} language={lang} />
      <SuccessNotice>{success}</SuccessNotice>
      {(adding || editing) && <AddressEditor initial={editing} onCancel={closeEditor} onSaved={saved} />}
      {auth.addressesLoading && !auth.addresses.length ? <div className="account-skeleton" role="status" aria-busy="true" aria-label={accountText(lang, "loading")} /> : (
        <div className="address-list">
          {!auth.addresses.length && !adding && <p className="account-empty">{accountText(lang, "noAddresses")}</p>}
          {auth.addresses.map((address) => (
            <article className={`address-card${address.isDefault ? " default" : ""}`} key={address.id}>
              <div className="address-card-main">
                <div className="address-title"><strong>{address.recipientName}</strong>{address.isDefault && <span>{accountText(lang, "defaultAddress")}</span>}</div>
                <p>{address.city}, {address.address}</p>
                <p>{address.phone}</p>
                {address.comment && <small>{address.comment}</small>}
              </div>
              <div className="address-actions">
                {!address.isDefault && <button type="button" onClick={() => makeDefault(address)} disabled={busyId === address.id}>{accountText(lang, "makeDefault")}</button>}
                <button type="button" onClick={() => { setEditing(address); setAdding(false); setSuccess(""); }}>{accountText(lang, "edit")}</button>
                <button type="button" className="danger" onClick={() => remove(address)} disabled={busyId === address.id}>{accountText(lang, "delete")}</button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function OrdersCard() {
  const { lang } = useShop();
  const auth = useAuth();
  const [orders, setOrders] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [status, setStatus] = React.useState("");
  const [total, setTotal] = React.useState(0);
  const requestRef = React.useRef(null);
  const load = React.useCallback((offset = 0, append = false) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    if (append) setLoadingMore(true); else setLoading(true);
    setError(null);
    auth.loadOrders({ limit: 10, offset, status, signal: controller.signal }).then((payload) => {
      const items = payload.items || [];
      setOrders((current) => append ? [...current, ...items] : items);
      setTotal(Number(payload.pagination?.total || 0));
    })
      .catch((caught) => { if (caught?.name !== "AbortError") setError(caught); })
      .finally(() => {
        if (requestRef.current !== controller || controller.signal.aborted) return;
        setLoading(false); setLoadingMore(false);
      });
  }, [auth.loadOrders, status]);
  React.useEffect(() => {
    load(0, false);
    return () => requestRef.current?.abort();
  }, [load]);
  return (
    <section className="account-card" id="orders" aria-labelledby="orders-title">
      <div className="account-card-head">
        <div><h2 id="orders-title">{accountText(lang, "orders")}</h2><p>{accountText(lang, "ordersLead")}</p></div>
        <label className="order-filter">
          <span>{accountText(lang, "filterStatus")}</span>
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">{accountText(lang, "allOrders")}</option>
            {ORDER_STATUSES.map((value) => <option key={value} value={value}>{orderStatusText(lang, value)}</option>)}
          </select>
        </label>
      </div>
      <ApiErrorNotice error={error} language={lang} />
      {error && <button type="button" className="account-secondary" onClick={() => load(0, false)}>{accountText(lang, "retry")}</button>}
      {loading ? <div className="account-skeleton tall" role="status" aria-busy="true" aria-label={accountText(lang, "loading")} /> : (
        <div className="order-list">
          {!orders.length && !error && <p className="account-empty">{accountText(lang, "noOrders")}</p>}
          {orders.map((order) => (
            <article className="order-row" key={order.id}>
              <div className="order-row-main">
                <strong>{accountText(lang, "order")} {order.no}</strong>
                <span>{formatDate(order.createdAt, lang)}</span>
              </div>
              <span className={`order-status status-${order.status}`}>{orderStatusText(lang, order.status)}</span>
              <div className="order-row-meta"><span>{accountText(lang, "itemsCount", { count: order.itemCount })}</span><b>{formatMoney(order.total, lang)}</b></div>
              <Link className="account-secondary compact" to={`/account/orders/${encodeURIComponent(order.id)}`}>{accountText(lang, "details")}<Icon n="chev" s={15} /></Link>
            </article>
          ))}
          {orders.length < total && <button className="account-secondary order-more" type="button" onClick={() => load(orders.length, true)} disabled={loadingMore}>
            {loadingMore ? accountText(lang, "loading") : accountText(lang, "loadMore")}
          </button>}
        </div>
      )}
    </section>
  );
}

function AccountContent() {
  const { lang } = useShop();
  const auth = useAuth();
  return (
    <div className="wrap page account-page">
      <header className="account-hero">
        <div><span>{accountText(lang, "account")}</span><h1>{auth.user.name}</h1><p>{auth.user.email}</p></div>
        <Link className="account-secondary" to="/logout"><Icon n="logout" s={17} />{accountText(lang, "logout")}</Link>
      </header>
      <div className="account-layout">
        <nav className="account-nav" aria-label={accountText(lang, "account")}>
          <a href="#profile"><Icon n="user" s={18} />{accountText(lang, "profile")}</a>
          <a href="#addresses"><Icon n="pin" s={18} />{accountText(lang, "addresses")}</a>
          <a href="#orders"><Icon n="bag" s={18} />{accountText(lang, "orders")}</a>
        </nav>
        <div className="account-content"><ProfileCard /><AddressesCard /><OrdersCard /></div>
      </div>
    </div>
  );
}

export default function AccountPage() {
  const { lang } = useShop();
  return <ProtectedAccount language={lang}><AccountContent /></ProtectedAccount>;
}

export { formatDate, formatMoney };
