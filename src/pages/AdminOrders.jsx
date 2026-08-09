import React from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Boxes,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Clock3,
  ExternalLink,
  FolderTree,
  LoaderCircle,
  LogOut,
  Mail,
  Package,
  Percent,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  ShoppingBag,
  ScrollText,
  Store,
  TicketPercent,
  UserRound,
  X,
} from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import {
  AdminApiError,
  adminRequest,
  clearAdminDevToken,
  saveAdminDevToken,
} from '../admin-api.js';
import AdminProducts from './AdminProducts.jsx';
import AdminCategories from './AdminCategories.jsx';
import AdminInventoryJournal from './AdminInventoryJournal.jsx';
import AdminAuditLog from './AdminAuditLog.jsx';
import AdminPromos from './AdminPromos.jsx';
import AdminDiscounts from './AdminDiscounts.jsx';
import AdminStatistics from './AdminStatistics.jsx';
import { handleTabListKeyDown, useDialogFocus } from '../dialog-a11y.js';
import '../admin.css';

const PAGE_SIZE = 30;
const ORDER_TABS = ['details', 'history', 'stock', 'returns', 'notifications'];
const STATUS = {
  pending: { label: 'Nouă', tone: 'rose' },
  confirmed: { label: 'Confirmată', tone: 'blue' },
  processing: { label: 'În lucru', tone: 'violet' },
  ready: { label: 'Pregătită', tone: 'amber' },
  shipped: { label: 'Expediată', tone: 'cyan' },
  completed: { label: 'Finalizată', tone: 'green' },
  cancelled: { label: 'Anulată', tone: 'gray' },
  returned: { label: 'Returnată', tone: 'red' },
};
const MOVEMENT = {
  reservation: 'Rezervare',
  reservation_release: 'Eliberare rezervă',
  sale: 'Vânzare',
  return: 'Retur',
  receipt: 'Intrare',
  write_off: 'Casare',
  adjustment: 'Ajustare',
  opening_balance: 'Sold inițial',
};

const money = (value) => `${new Intl.NumberFormat('ro-MD').format(Number(value || 0))} lei`;
const dateTime = (value) => value
  ? new Intl.DateTimeFormat('ro-MD', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : '—';
const statusMeta = (status) => STATUS[status] || { label: status, tone: 'gray' };

function StatusBadge({ status }) {
  const meta = statusMeta(status);
  return <span className={`adm-status adm-status-${meta.tone}`}>{meta.label}</span>;
}

function AdminLogin({ initialError, onAuthenticated }) {
  const [token, setToken] = React.useState('');
  const [error, setError] = React.useState(initialError || '');
  const [loading, setLoading] = React.useState(false);
  const local = ['localhost', '127.0.0.1'].includes(window.location.hostname);

  const submit = async (event) => {
    event.preventDefault();
    if (!local || !token.trim()) return;
    setLoading(true);
    setError('');
    saveAdminDevToken(token);
    try {
      const payload = await adminRequest('/api/admin/session');
      onAuthenticated(payload);
    } catch (requestError) {
      clearAdminDevToken();
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="adm-login-page">
      <form className="adm-login" onSubmit={submit}>
        <div className="adm-login-mark"><ShieldCheck size={26}/></div>
        <div className="adm-wordmark"><b>Nail Mania</b><span>Administrare</span></div>
        <h1>Acces administrativ</h1>
        {local ? (
          <>
            <label htmlFor="admin-token">Token local</label>
            <input
              id="admin-token"
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="current-password"
              autoFocus
            />
            {error && <div className="adm-auth-error" role="alert"><AlertTriangle size={16}/>{error}</div>}
            <button className="adm-primary" type="submit" disabled={loading || !token.trim()}>
              {loading ? <LoaderCircle className="adm-spin" size={18}/> : <ShieldCheck size={18}/>}
              Autentificare
            </button>
          </>
        ) : (
          <div className="adm-auth-error" role="alert"><AlertTriangle size={16}/>{error || 'Acces refuzat'}</div>
        )}
        <Link className="adm-back-link" to="/"><Store size={16}/>Înapoi la magazin</Link>
      </form>
    </div>
  );
}

function OrderReturnTool({ order, onReturn }) {
  const [quantities, setQuantities] = React.useState({});
  const [reason, setReason] = React.useState('');
  const [requestKey, setRequestKey] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const returnableItems = order.items.filter((item) => item.returnableQuantity > 0);

  React.useEffect(() => {
    setQuantities({});
    setReason('');
    setRequestKey('');
    setError('');
  }, [order.id]);

  const changeQuantity = (item, value) => {
    const quantity = Math.min(item.returnableQuantity, Math.max(0, Number.parseInt(value || '0', 10) || 0));
    setQuantities((current) => ({ ...current, [item.id]: quantity }));
    setRequestKey('');
    setError('');
  };
  const changeReason = (value) => {
    setReason(value);
    setRequestKey('');
    setError('');
  };
  const lines = returnableItems
    .map((item) => ({ orderItemId: item.id, quantity: quantities[item.id] || 0 }))
    .filter((item) => item.quantity > 0);

  const submit = async () => {
    if (saving || lines.length === 0 || reason.trim().length < 3) return;
    const key = requestKey || crypto.randomUUID();
    setRequestKey(key);
    setSaving(true);
    setError('');
    try {
      await onReturn(order.id, { reason: reason.trim(), items: lines }, key);
      setQuantities({});
      setReason('');
      setRequestKey('');
    } catch (returnError) {
      setError(returnError.message);
    } finally {
      setSaving(false);
    }
  };

  if (order.status !== 'completed' || returnableItems.length === 0) return null;
  return (
    <section className="adm-return-tool">
      <div className="adm-section-head"><h3><RotateCcw size={17}/>Înregistrează retur</h3><span>Selectează cantitatea primită fizic</span></div>
      <div className="adm-return-lines">
        {returnableItems.map((item) => (
          <label key={item.id}>
            <span><b>{item.name}</b><small>Vândut {item.soldQuantity} · returnat {item.returnedQuantity} · disponibil {item.returnableQuantity}</small></span>
            <input type="number" min="0" max={item.returnableQuantity} value={quantities[item.id] || 0} onChange={(event) => changeQuantity(item, event.target.value)}/>
          </label>
        ))}
      </div>
      <textarea value={reason} onChange={(event) => changeReason(event.target.value)} placeholder="Motivul returului (obligatoriu)" aria-label="Motivul returului" maxLength={1000}/>
      <button className="adm-primary" type="button" onClick={submit} disabled={saving || lines.length === 0 || reason.trim().length < 3}>
        {saving ? <LoaderCircle className="adm-spin" size={17}/> : <RotateCcw size={17}/>}Înregistrează returul
      </button>
      {error && <div className="adm-inline-error" role="alert">{error}</div>}
    </section>
  );
}

function OrderDrawer({
  order,
  loading,
  error,
  canViewPromoCodes,
  onClose,
  onTransition,
  onReturn,
  onSaveInternalComment,
  onResendTelegram,
}) {
  const [tab, setTab] = React.useState('details');
  const [nextStatus, setNextStatus] = React.useState('');
  const [comment, setComment] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState('');
  const [internalComment, setInternalComment] = React.useState('');
  const [commentRevision, setCommentRevision] = React.useState(null);
  const [commentSaving, setCommentSaving] = React.useState(false);
  const [commentError, setCommentError] = React.useState('');
  const [notificationSaving, setNotificationSaving] = React.useState(false);
  const [notificationError, setNotificationError] = React.useState('');
  const [notificationRequestKey, setNotificationRequestKey] = React.useState('');
  const dialogRef = useDialogFocus(onClose);

  React.useEffect(() => {
    setTab('details');
    setNextStatus('');
    setComment('');
    setSaveError('');
    setNotificationError('');
    setNotificationRequestKey('');
  }, [order?.id]);
  React.useEffect(() => {
    setInternalComment(order?.internalComment || '');
    setCommentRevision(order?.internalCommentRevision || null);
    setCommentError('');
  }, [order?.id, order?.internalComment, order?.internalCommentRevision]);
  const applyStatus = async () => {
    if (!order || !nextStatus || saving) return;
    setSaving(true);
    setSaveError('');
    try {
      await onTransition(order.id, nextStatus, comment);
      setNextStatus('');
      setComment('');
    } catch (transitionError) {
      setSaveError(transitionError.message);
    } finally {
      setSaving(false);
    }
  };

  const saveInternalComment = async () => {
    if (!order || commentSaving) return;
    setCommentSaving(true);
    setCommentError('');
    try {
      const updated = await onSaveInternalComment(order.id, internalComment, commentRevision);
      setCommentRevision(updated.internalCommentRevision || null);
    } catch (commentSaveError) {
      setCommentError(commentSaveError.message);
    } finally {
      setCommentSaving(false);
    }
  };

  const resendTelegram = async () => {
    if (!order || notificationSaving) return;
    const key = notificationRequestKey || crypto.randomUUID();
    setNotificationRequestKey(key);
    setNotificationSaving(true);
    setNotificationError('');
    try {
      const result = await onResendTelegram(order.id, key);
      setNotificationRequestKey('');
      if (!result.delivered) {
        setNotificationError(`Telegram: ${result.attempt?.failureCode || 'trimiterea a esuat'}`);
      }
    } catch (notificationSaveError) {
      setNotificationError(notificationSaveError.message);
    } finally {
      setNotificationSaving(false);
    }
  };

  const telegramNotifications = order?.notifications?.filter((entry) => entry.channel === 'telegram') || [];
  const emailNotifications = order?.notifications?.filter((entry) => entry.channel === 'email') || [];
  const latestTelegram = telegramNotifications.at(-1) || null;
  const telegramPendingIsStale = latestTelegram?.status === 'pending'
    && Date.now() - Date.parse(latestTelegram.createdAt || '') >= 5 * 60 * 1000;
  const telegramCanRetry = !latestTelegram
    || latestTelegram.status === 'failed'
    || telegramPendingIsStale;

  return (
    <div className="adm-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="adm-drawer" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Detalii comandă" tabIndex={-1}>
        <header className="adm-drawer-head">
          <div>
            <span>Comandă</span>
            <h2>{order?.no || 'Se încarcă'}</h2>
          </div>
          <button className="adm-icon-btn" type="button" onClick={onClose} title="Închide" aria-label="Închide" data-dialog-initial-focus><X size={20}/></button>
        </header>

        {loading && <div className="adm-drawer-state" role="status"><LoaderCircle className="adm-spin" size={24}/>Se încarcă</div>}
        {error && <div className="adm-drawer-state adm-error" role="alert"><AlertTriangle size={20}/>{error}</div>}
        {order && !loading && (
          <>
            <div className="adm-order-heading">
              <StatusBadge status={order.status}/>
              <span>{dateTime(order.createdAt)}</span>
              <b>{money(order.total)}</b>
            </div>

            {order.allowedTransitions?.length > 0 && (
              <section className="adm-transition-tool">
                <label htmlFor="next-status">Schimbă statutul</label>
                <div className="adm-transition-row">
                  <select id="next-status" value={nextStatus} onChange={(event) => setNextStatus(event.target.value)}>
                    <option value="">Selectează</option>
                    {Object.entries(STATUS).map(([status, meta]) => (
                      <option
                        value={status}
                        key={status}
                        disabled={status === order.status || !order.allowedTransitions.includes(status)}
                      >
                        {meta.label}{status === order.status ? ' (curent)' : ''}
                      </option>
                    ))}
                  </select>
                  <button className="adm-primary" type="button" onClick={applyStatus} disabled={!nextStatus || saving}>
                    {saving ? <LoaderCircle className="adm-spin" size={17}/> : <CheckCircle2 size={17}/>}
                    Actualizează
                  </button>
                </div>
                <textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Nota pentru istoricul schimbarii de statut" aria-label="Notă pentru istoricul schimbării de statut" maxLength={1000}/>
                {saveError && <div className="adm-inline-error" role="alert">{saveError}</div>}
              </section>
            )}

            <OrderReturnTool order={order} onReturn={onReturn}/>

            <div className="adm-tabs" role="tablist" aria-label="Secțiuni comandă" onKeyDown={(event) => handleTabListKeyDown(event, ORDER_TABS, tab, setTab)}>
              <button type="button" id="order-tab-details" aria-controls="order-panel-details" aria-selected={tab === 'details'} tabIndex={tab === 'details' ? 0 : -1} className={tab === 'details' ? 'active' : ''} onClick={() => setTab('details')} role="tab">Detalii</button>
              <button type="button" id="order-tab-history" aria-controls="order-panel-history" aria-selected={tab === 'history'} tabIndex={tab === 'history' ? 0 : -1} className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')} role="tab">Istoric <span>{order.history.length}</span></button>
              <button type="button" id="order-tab-stock" aria-controls="order-panel-stock" aria-selected={tab === 'stock'} tabIndex={tab === 'stock' ? 0 : -1} className={tab === 'stock' ? 'active' : ''} onClick={() => setTab('stock')} role="tab">Stoc <span>{order.movements.length}</span></button>
              <button type="button" id="order-tab-returns" aria-controls="order-panel-returns" aria-selected={tab === 'returns'} tabIndex={tab === 'returns' ? 0 : -1} className={tab === 'returns' ? 'active' : ''} onClick={() => setTab('returns')} role="tab">Retururi <span>{order.returns.length}</span></button>
              <button type="button" id="order-tab-notifications" aria-controls="order-panel-notifications" aria-selected={tab === 'notifications'} tabIndex={tab === 'notifications' ? 0 : -1} className={tab === 'notifications' ? 'active' : ''} onClick={() => setTab('notifications')} role="tab">Notificări <span>{order.notifications?.length || 0}</span></button>
            </div>

            <div className="adm-drawer-body" id={`order-panel-${tab}`} role="tabpanel" aria-labelledby={`order-tab-${tab}`}>
              {tab === 'details' && (
                <>
                  <section className="adm-detail-section">
                    <h3><UserRound size={17}/>Client</h3>
                    <dl className="adm-kv">
                      <div><dt>Nume</dt><dd>{order.customer.name}</dd></div>
                      <div><dt>Telefon</dt><dd><a href={`tel:${order.customer.phone}`}>{order.customer.phone}</a></dd></div>
                      <div><dt>Email</dt><dd>{order.customer.email || '—'}</dd></div>
                      <div><dt>Livrare</dt><dd>{order.deliveryLabel}{order.customer.city || order.customer.address ? ` · ${[order.customer.city, order.customer.address].filter(Boolean).join(', ')}` : ''}</dd></div>
                      <div><dt>Plată</dt><dd>{order.paymentLabel}</dd></div>
                    </dl>
                    {order.customer.comment && <div className="adm-comment">{order.customer.comment}</div>}
                  </section>

                  <section className="adm-detail-section adm-comment-editor">
                    <h3><ScrollText size={17}/>Comentariu intern manager</h3>
                    <textarea
                      value={internalComment}
                      onChange={(event) => { setInternalComment(event.target.value); setCommentError(''); }}
                      placeholder="Vizibil numai in administrare"
                      aria-label="Comentariu intern manager"
                      maxLength={2000}
                    />
                    <button
                      className="adm-primary"
                      type="button"
                      onClick={saveInternalComment}
                      disabled={commentSaving || internalComment.trim() === (order.internalComment || '')}
                    >
                      {commentSaving ? <LoaderCircle className="adm-spin" size={17}/> : <CheckCircle2 size={17}/>}
                      Salveaza comentariul
                    </button>
                    {commentError && <div className="adm-inline-error" role="alert">{commentError}</div>}
                  </section>

                  <section className="adm-detail-section">
                    <h3><Package size={17}/>Produse</h3>
                    <div className="adm-lines">
                      {order.items.map((item) => (
                        <div className="adm-line" key={item.id}>
                          <div><b>{item.name}</b><span>{item.sku || item.productKey} · comandat {item.quantity}{item.soldQuantity > 0 ? ` · vândut ${item.soldQuantity} · returnat ${item.returnedQuantity}` : ''}</span></div>
                          <strong>{money(item.lineTotal)}</strong>
                        </div>
                      ))}
                    </div>
                    <dl className="adm-totals">
                      <div><dt>Produse</dt><dd>{money(order.itemsSubtotal)}</dd></div>
                      {order.catalogDiscount > 0 && <div><dt>Reducere catalog</dt><dd>-{money(order.catalogDiscount)}</dd></div>}
                      {order.promoDiscount > 0 && (
                        <div>
                          <dt>{canViewPromoCodes && order.promoCode ? `Promocod ${order.promoCode}` : 'Reducere promo'}</dt>
                          <dd>-{money(order.promoDiscount)}</dd>
                        </div>
                      )}
                      <div><dt>Livrare</dt><dd>{money(order.deliveryFee)}</dd></div>
                      <div className="grand"><dt>Total</dt><dd>{money(order.total)}</dd></div>
                    </dl>
                  </section>
                </>
              )}

              {tab === 'history' && (
                <section className="adm-detail-section">
                  <h3><Clock3 size={17}/>Istoric statut</h3>
                  <div className="adm-timeline">
                    {[...order.history].reverse().map((entry) => (
                      <div className="adm-timeline-item" key={entry.id}>
                        <i/>
                        <div>
                          <StatusBadge status={entry.toStatus}/>
                          <time>{dateTime(entry.createdAt)}</time>
                          {entry.comment && <p>{entry.comment}</p>}
                          {entry.actor && <small>{entry.actor.name || entry.actor.email}</small>}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {tab === 'stock' && (
                <section className="adm-detail-section">
                  <h3><Package size={17}/>Mișcări de stoc</h3>
                  <div className="adm-movements">
                    {[...order.movements].reverse().map((movement) => (
                      <div className="adm-movement" key={movement.id}>
                        <div><b>{MOVEMENT[movement.type] || movement.type}</b><span>{movement.product.name}</span><time>{dateTime(movement.createdAt)}</time></div>
                        <div className="adm-deltas">
                          <span className={movement.deltaOnHand > 0 ? 'plus' : movement.deltaOnHand < 0 ? 'minus' : ''}>Fizic {movement.deltaOnHand > 0 ? '+' : ''}{movement.deltaOnHand}</span>
                          <span className={movement.deltaReserved > 0 ? 'plus' : movement.deltaReserved < 0 ? 'minus' : ''}>Rezervat {movement.deltaReserved > 0 ? '+' : ''}{movement.deltaReserved}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {tab === 'returns' && (
                <section className="adm-detail-section">
                  <h3><RotateCcw size={17}/>Documente de retur</h3>
                  {order.returns.length === 0 && <div className="adm-muted-empty">Nu sunt retururi</div>}
                  <div className="adm-return-history">
                    {[...order.returns].reverse().map((entry) => (
                      <article key={entry.id}>
                        <header><b>{entry.kind === 'full' ? 'Retur complet' : 'Retur parțial'}</b><strong>{money(entry.refundAmount)}</strong></header>
                        <time>{dateTime(entry.createdAt)} · {entry.actor?.name || entry.actor?.email || 'Sistem'}</time>
                        <p>{entry.reason}</p>
                        {entry.promoRefundAmount > 0 && <small>Produse {money(entry.itemsAmount)} · reversare promo −{money(entry.promoRefundAmount)}</small>}
                        {entry.items.map((item) => <small key={item.id}>{item.name} · {item.quantity} buc.</small>)}
                      </article>
                    ))}
                  </div>
                </section>
              )}

              {tab === 'notifications' && (
                <section className="adm-detail-section">
                  <div className="adm-section-head">
                    <h3><RefreshCw size={17}/>Telegram</h3>
                    {telegramCanRetry && (
                      <button className="adm-primary" type="button" onClick={resendTelegram} disabled={notificationSaving}>
                        {notificationSaving ? <LoaderCircle className="adm-spin" size={17}/> : <RefreshCw size={17}/>}
                        Retrimite
                      </button>
                    )}
                  </div>
                  {telegramNotifications.length === 0 && <div className="adm-muted-empty">Nu exista incercari inregistrate</div>}
                  <div className="adm-return-history adm-notification-history">
                    {[...telegramNotifications].reverse().map((entry) => (
                      <article key={entry.id}>
                        <header>
                          <b>{entry.eventType === 'order_created' ? 'Comanda creata' : 'Retrimitere manuala'}</b>
                          <strong className={`adm-notification-${entry.status}`}>
                            {entry.status === 'sent' ? 'Trimis' : entry.status === 'failed' ? 'Eroare' : 'In asteptare'}
                          </strong>
                        </header>
                        <time>{dateTime(entry.createdAt)}{entry.actor ? ` · ${entry.actor.name || entry.actor.email}` : ''}</time>
                        {entry.failureCode && <small>{entry.failureCode}{entry.providerStatus ? ` · HTTP ${entry.providerStatus}` : ''}</small>}
                      </article>
                    ))}
                  </div>
                  <div className="adm-section-head adm-notification-channel">
                    <h3><Mail size={17}/>Email client</h3>
                  </div>
                  {emailNotifications.length === 0 && <div className="adm-muted-empty">Nu există încercări înregistrate</div>}
                  <div className="adm-return-history adm-notification-history">
                    {[...emailNotifications].reverse().map((entry) => (
                      <article key={entry.id}>
                        <header>
                          <b>Confirmare comandă</b>
                          <strong className={`adm-notification-${entry.status}`}>
                            {entry.status === 'sent' ? 'Trimis' : entry.status === 'failed' ? 'Eroare' : 'În așteptare'}
                          </strong>
                        </header>
                        <time>{dateTime(entry.createdAt)}</time>
                        {entry.failureCode && <small>{entry.failureCode}{entry.providerStatus ? ` · HTTP ${entry.providerStatus}` : ''}</small>}
                      </article>
                    ))}
                  </div>
                  {notificationError && <div className="adm-inline-error" role="alert">{notificationError}</div>}
                </section>
              )}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

export default function AdminOrders() {
  const { pathname } = useLocation();
  const productsMode = pathname.startsWith('/admin/products');
  const categoriesMode = pathname.startsWith('/admin/categories');
  const inventoryMode = pathname.startsWith('/admin/inventory');
  const auditMode = pathname.startsWith('/admin/audit');
  const promosMode = pathname.startsWith('/admin/promos');
  const discountsMode = pathname.startsWith('/admin/discounts');
  const statisticsMode = pathname.startsWith('/admin/statistics');
  const ordersMode = !productsMode && !categoriesMode && !inventoryMode && !auditMode && !promosMode && !discountsMode && !statisticsMode;
  const [session, setSession] = React.useState(null);
  const [authChecked, setAuthChecked] = React.useState(false);
  const [authError, setAuthError] = React.useState('');
  const [orders, setOrders] = React.useState([]);
  const [counts, setCounts] = React.useState({});
  const [pagination, setPagination] = React.useState({ total: 0, offset: 0, limit: PAGE_SIZE });
  const [status, setStatus] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [listError, setListError] = React.useState('');
  const [selectedId, setSelectedId] = React.useState('');
  const [detail, setDetail] = React.useState(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailError, setDetailError] = React.useState('');

  React.useEffect(() => {
    const title = productsMode ? 'Produse' : categoriesMode ? 'Categorii' : discountsMode ? 'Reduceri' : inventoryMode ? 'Jurnal de stoc' : promosMode ? 'Coduri promo' : statisticsMode ? 'Statistică' : auditMode ? 'Audit' : 'Comenzi';
    document.title = `${title} · Nail Mania Admin`;
    document.body.classList.add('adm-body-active');
    return () => document.body.classList.remove('adm-body-active');
  }, [auditMode, categoriesMode, discountsMode, inventoryMode, productsMode, promosMode, statisticsMode]);

  const checkSession = React.useCallback(async () => {
    try {
      const payload = await adminRequest('/api/admin/session');
      setSession(payload);
      setAuthError('');
    } catch (error) {
      setSession(null);
      setAuthError(error.message);
    } finally {
      setAuthChecked(true);
    }
  }, []);
  React.useEffect(() => { checkSession(); }, [checkSession]);
  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const loadOrders = React.useCallback(async (nextOffset = pagination.offset) => {
    if (!session) return;
    setLoading(true);
    setListError('');
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(nextOffset) });
      if (status) params.set('status', status);
      if (query) params.set('q', query);
      const payload = await adminRequest(`/api/admin/orders?${params}`);
      setOrders(payload.items);
      setCounts(payload.counts);
      setPagination(payload.pagination);
    } catch (error) {
      setListError(error.message);
      if (error instanceof AdminApiError && [401, 403].includes(error.status)) setSession(null);
    } finally {
      setLoading(false);
    }
  }, [pagination.offset, query, session, status]);
  React.useEffect(() => { if (session && ordersMode) loadOrders(0); }, [session, status, query, ordersMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const openOrder = React.useCallback(async (id) => {
    setSelectedId(id);
    setDetail(null);
    setDetailLoading(true);
    setDetailError('');
    try {
      const payload = await adminRequest(`/api/admin/orders/${encodeURIComponent(id)}`);
      setDetail(payload.order);
    } catch (error) {
      setDetailError(error.message);
    } finally {
      setDetailLoading(false);
    }
  }, []);
  const closeOrder = React.useCallback(() => { setSelectedId(''); setDetail(null); setDetailError(''); }, []);
  const transition = React.useCallback(async (id, nextStatus, comment) => {
    const payload = await adminRequest(`/api/admin/orders/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { status: nextStatus, comment },
    });
    setDetail(payload.order);
    await loadOrders(pagination.offset);
  }, [loadOrders, pagination.offset]);
  const createReturn = React.useCallback(async (id, body, requestKey) => {
    const payload = await adminRequest(`/api/admin/orders/${encodeURIComponent(id)}/returns`, {
      method: 'POST',
      headers: { 'idempotency-key': requestKey },
      body,
    });
    setDetail(payload.order);
    await loadOrders(pagination.offset);
  }, [loadOrders, pagination.offset]);
  const saveInternalComment = React.useCallback(async (id, comment, expectedRevision) => {
    const payload = await adminRequest(`/api/admin/orders/${encodeURIComponent(id)}/internal-comment`, {
      method: 'PATCH',
      body: { comment, expectedRevision },
    });
    setDetail(payload.order);
    return payload.order;
  }, []);
  const resendTelegram = React.useCallback(async (id, requestKey) => {
    const payload = await adminRequest(`/api/admin/orders/${encodeURIComponent(id)}/notifications/telegram`, {
      method: 'POST',
      headers: { 'idempotency-key': requestKey },
    });
    setDetail(payload.order);
    return payload;
  }, []);

  const logout = () => {
    clearAdminDevToken();
    setSession(null);
    setAuthChecked(true);
  };
  const invalidateSession = React.useCallback(() => setSession(null), []);

  if (!authChecked) return <div className="adm-boot" role="status" aria-label="Se verifică accesul"><LoaderCircle className="adm-spin" size={26}/></div>;
  if (!session) return <AdminLogin initialError={authError} onAuthenticated={(payload) => { setSession(payload); setAuthError(''); }}/>;

  const isAdmin = session.user.role === 'admin';
  const adminOnlyMessage = <div className="adm-list-message adm-error"><AlertTriangle size={18}/>Acces permis doar administratorilor</div>;
  const totalPages = Math.max(1, Math.ceil(pagination.total / PAGE_SIZE));
  const currentPage = Math.floor(pagination.offset / PAGE_SIZE) + 1;
  return (
    <div className="adm-app">
      <aside className="adm-sidebar">
        <div className="adm-brand"><span>nm</span><div><b>Nail Mania</b><small>Administrare</small></div></div>
        <nav>
          <Link aria-label="Comenzi" aria-current={ordersMode ? 'page' : undefined} className={ordersMode ? 'active' : ''} to="/admin/orders"><ShoppingBag size={19}/><span>Comenzi</span>{(counts.pending || 0) > 0 && <i>{counts.pending}</i>}</Link>
          <Link aria-label="Produse" aria-current={productsMode ? 'page' : undefined} className={productsMode ? 'active' : ''} to="/admin/products"><Boxes size={19}/><span>Produse</span></Link>
          <Link aria-label="Categorii" aria-current={categoriesMode ? 'page' : undefined} className={categoriesMode ? 'active' : ''} to="/admin/categories"><FolderTree size={19}/><span>Categorii</span></Link>
          <Link aria-label="Reduceri" aria-current={discountsMode ? 'page' : undefined} className={discountsMode ? 'active' : ''} to="/admin/discounts"><Percent size={19}/><span>Reduceri</span></Link>
          {isAdmin && <Link aria-label="Coduri promo" aria-current={promosMode ? 'page' : undefined} className={promosMode ? 'active' : ''} to="/admin/promos"><TicketPercent size={19}/><span>Coduri promo</span></Link>}
          <Link aria-label="Jurnal stoc" aria-current={inventoryMode ? 'page' : undefined} className={inventoryMode ? 'active' : ''} to="/admin/inventory"><ClipboardList size={19}/><span>Jurnal stoc</span></Link>
          {isAdmin && <Link aria-label="Statistică" aria-current={statisticsMode ? 'page' : undefined} className={statisticsMode ? 'active' : ''} to="/admin/statistics"><BarChart3 size={19}/><span>Statistică</span></Link>}
          {isAdmin && <Link aria-label="Audit" aria-current={auditMode ? 'page' : undefined} className={auditMode ? 'active' : ''} to="/admin/audit"><ScrollText size={19}/><span>Audit</span></Link>}
          <Link aria-label="Deschide magazinul într-o filă nouă" to="/" target="_blank" rel="noopener noreferrer"><ExternalLink size={19}/><span>Magazin</span></Link>
        </nav>
        <div className="adm-sidebar-user">
          <div><b>{session.user.name || session.user.email}</b><span>{session.user.role}</span></div>
          {session.authSource === 'local'
            ? <button type="button" onClick={logout} title="Ieșire" aria-label="Ieșire din administrare"><LogOut size={18}/></button>
            : <a href="/cdn-cgi/access/logout" title="Ieșire" aria-label="Închide sesiunea Cloudflare Access"><LogOut size={18}/></a>}
        </div>
      </aside>

      <main className="adm-main">
        {productsMode ? <AdminProducts onUnauthorized={invalidateSession}/>
          : categoriesMode ? <AdminCategories onUnauthorized={invalidateSession}/>
            : discountsMode ? <AdminDiscounts onUnauthorized={invalidateSession}/>
              : promosMode ? (isAdmin ? <AdminPromos onUnauthorized={invalidateSession}/> : adminOnlyMessage)
              : inventoryMode ? <AdminInventoryJournal onUnauthorized={invalidateSession}/>
              : statisticsMode ? (isAdmin ? <AdminStatistics onUnauthorized={invalidateSession}/> : adminOnlyMessage)
              : auditMode ? (isAdmin ? <AdminAuditLog onUnauthorized={invalidateSession}/> : adminOnlyMessage) : (
          <>
            <header className="adm-topbar">
              <div><span>Vânzări</span><h1>Comenzi</h1></div>
              <button className="adm-icon-btn" type="button" onClick={() => loadOrders(pagination.offset)} title="Actualizează"><RefreshCw className={loading ? 'adm-spin' : ''} size={19}/></button>
            </header>

            <section className="adm-summary adm-order-summary" aria-label="Sumar comenzi">
              {Object.keys(STATUS).map((key) => (
                <button type="button" key={key} aria-pressed={status === key} className={status === key ? 'active' : ''} onClick={() => setStatus(status === key ? '' : key)}>
                  <span>{statusMeta(key).label}</span><b>{counts[key] || 0}</b>
                </button>
              ))}
            </section>

            <section className="adm-orders-panel">
              <div className="adm-toolbar">
                <div className="adm-search"><Search size={18}/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Număr, client, telefon" aria-label="Caută comenzi"/></div>
                <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filtru statut">
                  <option value="">Toate statutele</option>
                  {Object.entries(STATUS).map(([key, meta]) => <option key={key} value={key}>{meta.label}</option>)}
                </select>
                {(status || query) && <button className="adm-clear" type="button" onClick={() => { setStatus(''); setSearch(''); }}>Resetează</button>}
              </div>

              {listError && <div className="adm-list-message adm-error" role="alert"><AlertTriangle size={18}/>{listError}</div>}
              {!listError && !loading && orders.length === 0 && <div className="adm-list-message"><ShoppingBag size={24}/>Nu sunt comenzi</div>}
              <div className="adm-table-wrap">
                <table className="adm-table">
                  <thead><tr><th>Comandă</th><th>Client</th><th>Produse</th><th>Livrare</th><th>Total</th><th>Statut</th><th aria-label="Acțiune"/></tr></thead>
                  <tbody>
                    {orders.map((order) => (
                      <tr key={order.id} onClick={() => openOrder(order.id)}>
                        <td><b>{order.no}</b><span>{dateTime(order.createdAt)}</span></td>
                        <td><b>{order.customerName}</b><span>{order.customerPhone}</span></td>
                        <td>{order.itemCount} buc.<span>{order.lineCount} poziții</span></td>
                        <td>{order.deliveryLabel}</td>
                        <td><strong>{money(order.total)}</strong></td>
                        <td><StatusBadge status={order.status}/></td>
                        <td><button className="adm-row-open" type="button" title="Deschide" onClick={(event) => { event.stopPropagation(); openOrder(order.id); }}><ChevronRight size={18}/></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {loading && <div className="adm-table-loading" role="status" aria-label="Se încarcă comenzile"><LoaderCircle className="adm-spin" size={24}/></div>}
              </div>

              <footer className="adm-pagination">
                <span>{pagination.total} comenzi · pagina {currentPage} din {totalPages}</span>
                <div>
                  <button className="adm-icon-btn" type="button" title="Pagina precedentă" disabled={pagination.offset === 0 || loading} onClick={() => loadOrders(Math.max(0, pagination.offset - PAGE_SIZE))}><ArrowLeft size={18}/></button>
                  <button className="adm-icon-btn" type="button" title="Pagina următoare" disabled={pagination.offset + PAGE_SIZE >= pagination.total || loading} onClick={() => loadOrders(pagination.offset + PAGE_SIZE)}><ArrowRight size={18}/></button>
                </div>
              </footer>
            </section>
          </>
        )}
      </main>

      {ordersMode && selectedId && (
        <OrderDrawer
          order={detail}
          loading={detailLoading}
          error={detailError}
          canViewPromoCodes={isAdmin}
          onClose={closeOrder}
          onTransition={transition}
          onReturn={createReturn}
          onSaveInternalComment={saveInternalComment}
          onResendTelegram={resendTelegram}
        />
      )}
    </div>
  );
}
