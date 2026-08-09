import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { COURIER_DELIVERY_FEE, FREE_DELIVERY_THRESHOLD } from '../shared/order-rules.js';

const source = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('storefront RO and RU dictionaries have identical UI coverage', () => {
  const data = source('src/data.js');
  const block = data
    .slice(data.indexOf('export const I18N'), data.indexOf('// ---- Category presentation'))
    .replace('export const I18N', 'I18N');
  const context = { COURIER_DELIVERY_FEE, FREE_DELIVERY_THRESHOLD };
  vm.createContext(context);
  vm.runInContext(block, context);
  const ro = [...Object.keys(context.I18N.ro)].sort();
  const ru = [...Object.keys(context.I18N.ru)].sort();
  assert.deepEqual(ro, ru);
  for (const key of ['close', 'removeItem', 'increaseQty', 'decreaseQty', 'orderQuoteChanged', 'orderAttemptConflict', 'newOrderAttempt']) {
    assert.ok(context.I18N.ro[key], `missing RO ${key}`);
    assert.ok(context.I18N.ru[key], `missing RU ${key}`);
  }
  assert.match(context.I18N.ro.d2, new RegExp(`${COURIER_DELIVERY_FEE}.*${FREE_DELIVERY_THRESHOLD}`));
  assert.match(context.I18N.ru.d2, new RegExp(`${COURIER_DELIVERY_FEE}.*${FREE_DELIVERY_THRESHOLD}`));
  assert.doesNotMatch(JSON.stringify(context.I18N), /gratuit de la 300|бесплатно от 300|în Europa|в Европу/);
});

test('checkout keeps authoritative quote UX and exposes native accessible controls', () => {
  const checkout = source('src/pages/Checkout.jsx');
  assert.match(checkout, /calculateDeliveryFee\(delivery, localMerchandiseSubtotal\)/);
  assert.match(checkout, /normalizeExpectedOrderQuote/);
  assert.match(checkout, /ORDER_QUOTE_CHANGED/);
  assert.match(checkout, /type="radio" name="delivery"/);
  assert.match(checkout, /type="radio" name="payment"/);
  assert.match(checkout, /htmlFor=\{id\}/);
  assert.match(checkout, /aria-invalid=\{Boolean\(errors\[k\]\)\}/);
  assert.match(checkout, /MOLDOVA_COUNTRY_CODE/);
  assert.match(checkout, /sanitizeMoldovaPhoneInput/);
  assert.match(checkout, /pattern="\[1-9\]\[0-9\]\{7\}"/);
  assert.match(checkout, /IDEMPOTENCY_KEY_REUSED/);
  assert.match(checkout, /window\.confirm\(t\("newOrderAttemptConfirm"\)\)/);
  assert.doesNotMatch(checkout, /href="#"/);
  assert.doesNotMatch(checkout, /agreeLink|co-agree-term/);
});

test('storefront persistence effects never return storage status as React cleanup', () => {
  const shop = source('src/shop.jsx');
  assert.match(shop, /useEffect\(\(\)=>\{ writeStoredValue\("nm_cart",JSON\.stringify\(cart\)\); \},\[cart\]\)/);
  assert.match(shop, /useEffect\(\(\)=>\{ writeStoredValue\("nm_favs",JSON\.stringify\(favs\)\); \},\[favs\]\)/);
  assert.doesNotMatch(shop, /useEffect\(\(\)=>writeStoredValue\(/);
});

test('storefront overlays and live search have keyboard and dialog semantics', () => {
  const header = source('src/components/Header.jsx');
  const menus = source('src/components/Menus.jsx');
  assert.match(header, /role="combobox"/);
  assert.match(header, /event\.key === "ArrowDown"/);
  assert.match(header, /aria-activedescendant/);
  assert.match(header, /<button className="logo"/);
  assert.doesNotMatch(menus, /<a onClick=/);
  assert.match(menus, /useDialogFocus/);
  assert.match(menus, /role="dialog"/);
  assert.match(menus, /aria-live="polite"/);
});

test('storefront content uses real destinations, page headings, filters and not-found routing', () => {
  const app = source('src/App.jsx');
  const content = source('src/components/Content.jsx');
  const seo = source('src/components/Seo.jsx');
  const data = source('src/data.js');
  const catalogData = source('src/catalog-data.js');
  const accountCatalog = source('src/account-catalog.js');
  const category = source('src/pages/CategoryPage.jsx');
  const brand = source('src/pages/BrandPage.jsx');
  const product = source('src/pages/ProductPage.jsx');
  const shop = source('src/shop.jsx');

  assert.doesNotMatch(content, /href="#"|<a onClick=/);
  assert.match(content, /https:\/\/wa\.me\/37368067486/);
  assert.match(content, /id="brands"/);
  assert.match(content, /to="\/#brands"/);
  assert.match(content, /<h1>\{t\("deliveryTitle"\)\}<\/h1>/);
  assert.match(content, /<h1>\{t\("payTitle"\)\}<\/h1>/);
  assert.match(content, /<h1>\{t\("contact"\)\}<\/h1>/);
  assert.match(app, /<Route path="\*" element=\{<NotFound\/>\}\/?>/);
  assert.doesNotMatch(app, /<Route path="\*" element=\{<Home\/>\}/);
  assert.match(seo, /'\/login':'Autentificare \| Nail Mania'/);
  assert.match(seo, /account\\\/orders/);
  assert.match(seo, /productsByBrand\(brand\)\.length/);
  assert.doesNotMatch(seo, /Europa|Europe/);
  assert.match(product, /<button type="button" key=\{i\} className=\{"pd-thumb"/);
  assert.match(product, /aria-pressed=\{i===shot\}/);
  assert.match(shop, /useEffect\(\(\)=>setFailed\(false\),\[img\]\)/);
  assert.match(data, /export const productGallery = \(p\)=>/);
  assert.match(data, /return \[\];/);
  for (const catalogSource of [catalogData, accountCatalog]) {
    assert.match(catalogSource, /img: productGallery\(p(?:roduct)?\)\[0\]/);
    assert.doesNotMatch(catalogSource, /images\/products|productImg/);
  }
  for (const filters of [category, brand]) {
    assert.match(filters, /role="group"/);
    assert.match(filters, /aria-pressed=/);
  }
  assert.doesNotMatch(category, /role="tablist"/);
});

test('admin mobile navigation and editors retain accessible names and focus handling', () => {
  const orders = source('src/pages/AdminOrders.jsx');
  const products = source('src/pages/AdminProducts.jsx');
  const categories = source('src/pages/AdminCategories.jsx');
  const promos = source('src/pages/AdminPromos.jsx');
  const discounts = source('src/pages/AdminDiscounts.jsx');
  const productScopePicker = source('src/components/AdminProductScopePicker.jsx');
  const inventory = source('src/pages/AdminInventoryJournal.jsx');
  const audit = source('src/pages/AdminAuditLog.jsx');
  for (const file of [orders, products, categories, promos, discounts]) assert.match(file, /useDialogFocus/);
  assert.match(orders, /aria-current=\{ordersMode/);
  assert.match(orders, /aria-selected=\{tab === 'details'\}/);
  assert.match(orders, /href="\/cdn-cgi\/access\/logout"/);
  assert.match(orders, /aria-label="Motivul returului"/);
  assert.match(orders, /aria-label="Comentariu intern manager"/);
  assert.match(orders, /const isAdmin = session\.user\.role === 'admin'/);
  assert.match(orders, /\{isAdmin && <Link aria-label="Coduri promo"/);
  assert.match(orders, /<Link aria-label="Reduceri"/);
  assert.match(orders, /\{isAdmin && <Link aria-label="Statistică"/);
  assert.match(orders, /promosMode \? \(isAdmin \? <AdminPromos/);
  assert.match(orders, /statisticsMode \? \(isAdmin \? <AdminStatistics/);
  assert.match(orders, /canViewPromoCodes && order\.promoCode/);
  assert.match(orders, /canViewPromoCodes=\{isAdmin\}/);
  assert.match(orders, /Object\.keys\(STATUS\)\.map/);
  assert.match(orders, /!order\.allowedTransitions\.includes\(status\)/);
  assert.match(products, /handleTabListKeyDown/);
  assert.match(products, /aria-label=\{`Denumirea specificației/);
  assert.match(products, /aria-label="Adresa imaginii"/);
  assert.match(productScopePicker, /aria-label=\{`Caută produse pentru \$\{label\}`\}/);
  assert.match(productScopePicker, /onUnauthorized/);
  assert.match(productScopePicker, /searchSequence/);
  assert.match(promos, /Branduri eligibile/);
  assert.match(promos, /scopesReady/);
  assert.match(promos, /scopeError/);
  assert.match(promos, /indisponibil/);
  assert.match(discounts, /Categorii întregi/);
  assert.match(discounts, /Branduri întregi/);
  assert.match(discounts, /discountDraftFingerprint/);
  assert.match(discounts, /previewSequence/);
  assert.match(discounts, /discountId/);
  assert.match(discounts, /aria-pressed=\{state === 'active'\}/);
  assert.match(inventory, /aria-label="Caută în jurnalul de stoc"/);
  assert.match(audit, /aria-label="Caută în jurnalul de audit"/);
  assert.match(promos, /adm-summary-metric/);
});

test('checkout and admin include narrow-screen layouts without hiding named navigation', () => {
  const pagesCss = source('src/pages.css');
  const adminCss = source('src/admin.css');
  assert.match(pagesCss, /@media\(max-width:380px\)/);
  assert.match(pagesCss, /\.co-card,\.co-sum\{padding:20px\}/);
  assert.match(adminCss, /@media\(max-width:760px\)/);
  assert.match(adminCss, /\.adm-sidebar nav\{overflow-x:auto\}/);
});
