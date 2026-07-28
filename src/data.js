/* ===== Nail Mania data: categories, products, brands, i18n (RO/RU) ===== */

import { catalogImageUrls } from '../shared/catalog-images.js';
import { COURIER_DELIVERY_FEE, FREE_DELIVERY_THRESHOLD } from '../shared/order-rules.js';

// ---- UI strings ----
export const I18N = {
  ro:{
    topPromo:`Livrare gratuită prin Moldova de la ${FREE_DELIVERY_THRESHOLD} lei`,
    hours:"Zilnic 09:00–18:00",
    workHours:"Luni–Sâmbătă 09:00–18:00 · Duminică 10:00–16:00",
    catalog:"Catalog", searchPh:"Caută produse, branduri…", search:"Caută",
    fav:"Favorite", cart:"Coș", menu:"Meniu", close:"Închide",
    removeItem:"Elimină produsul", increaseQty:"Mărește cantitatea", decreaseQty:"Micșorează cantitatea",
    navNew:"Noutăți", navSale:"Reduceri", navBrands:"Branduri", navDelivery:"Livrare", navContact:"Contacte", navPayment:"Plată",
    heroKicker:"Colecția de sezon", heroTitle:"Trendurile\nsezonului", heroText:"Geluri, baze și topuri pentru maeștrii manichiurii — totul într-un singur loc.",
    heroBtn:"Trendurile sezonului", heroBtn2:"Noutăți",
    pillCatalog:"Catalog", pillNew:"Noutăți", pillSale:"Reduceri",
    catsTitle:"Categorii de produse",
    secBest:"Trendurile sezonului", secNew:"Noi sosiri la Nail Mania", secSale:"Produse la reducere", secSummer:"Promoții",
    all:"Toate", addCart:"În coș", inCart:"În coș ✓", quickAdd:"Adaugă rapid",
    brandsTitle:"Brandurile noastre", brandsSub:"Lucrăm doar cu producători de încredere",
    allBrands:"Toate brandurile", filterBrand:"Brand",
    allCats:"Toate categoriile", filterCat:"Categorie",
    deliveryTitle:"Livrare", deliverySub:"Ridicare gratuită din magazin sau livrare prin curier în toată Moldova",
    d1:"Ridicare din magazinul Nail Mania — gratuit",
    d2:`Curier în Moldova — ${COURIER_DELIVERY_FEE} lei (gratuit de la ${FREE_DELIVERY_THRESHOLD} lei)`,
    termsTitle:"Termene de livrare",
    t1:"Ridicare din magazin — în ~1 oră (comenzi până la 17:00)",
    t2:"Termenul livrării prin curier este confirmat de manager în funcție de localitate",
    contact:"Contacte", emptyCart:"Coșul tău este gol", emptyFav:"Nu ai produse favorite",
    total:"Total", checkout:"Finalizează comanda", clear:"Golește", goShop:"La cumpărături",
    footAbout:"Magazin pentru maeștrii manichiurii și pedichiurii din Moldova.",
    colCatalog:"Catalog", colInfo:"Informații", colContact:"Contacte",
    newBadge:"NOU", saleBadge:"-", off:"reducere",
    results:"rezultate", noResults:"Nimic găsit", pageNotFound:"Pagina nu a fost găsită", pageNotFoundText:"Verifică adresa sau revino la pagina principală.", featured:"Recomandat",
    addedToast:"Adăugat în coș", stockLimitReached:"Maxim disponibil", lei:"lei",
    menuTitle:"Meniu", langLabel:"Limba",
    // ---- product page ----
    home:"Acasă", inStock:"În stoc", outOfStock:"Stoc epuizat", code:"Cod", qty:"Cantitate",
    buyOneClick:"Cumpără într-un clic", goCheckout:"Spre finalizare",
    descTitle:"Descriere", charTitle:"Caracteristici",
    charBrand:"Brand", charCat:"Categorie", charCode:"Cod", charAvail:"Disponibilitate",
    relatedTitle:"Produse similare", notFound:"Produsul nu a fost găsit", backHome:"Înapoi la magazin",
    descA:"de la {brand} — produs profesional din categoria „{cat}”, creat pentru maeștrii manichiurii și pedichiurii. Calitate înaltă, rezultat durabil și aplicare ușoară.",
    descB:"Formulă testată în salon, ambalaj comod și consum economic. Comandă acum și ridică din magazin sau prin curier în toată Moldova.",
    // ---- checkout ----
    checkoutTitle:"Finalizarea comenzii", deliverySection:"Livrare",
    chooseDelivery:"Alege metoda de livrare",
    courier:"Curier", courierDesc:"Livrare la adresă prin toată Moldova",
    pickup:"Ridicare din magazin", pickupDesc:"str. Romană 66/2, Ungheni — gratuit",
    recipient:"Destinatar", fullName:"Nume și Prenume", phone:"Telefon mobil",
    emailLabel:"Email", addressLabel:"Adresa de livrare", cityLabel:"Oraș / Localitate",
    commentLabel:"Comentariu", commentPh:"Comentariu la comandă (opțional)",
    paymentSection:"Metoda de plată",
    payMia:"MIA", payMiaDesc:"Plată instant prin aplicația MIA",
    payCard:"Transfer pe card", payCardDesc:"Transfer bancar pe card",
    payCash:"Numerar la primire", payCashDesc:"Plătești la curier sau în magazin",
    payTitle:"Plată", payLead:"Puteți achita comanda prin mai multe metode:",
    payOnDelivery:"La livrare", payPickup:"La ridicare din magazinul Nail Mania (Ungheni)",
    payDel1:"Numerar, direct curierului",
    payDel2:"Ramburs, pentru comenzile expediate prin Nova Poshta",
    payPick1:"Numerar",
    payPick2:"Cu cardul bancar",
    payPick3:"Prin transfer bancar (în baza contului)",
    payNote:"Pentru o altă metodă (de exemplu, din străinătate), contactați-ne la +373 68 067 486 (WhatsApp, Viber) și indicați metoda aleasă în comentariul comenzii.",
    contIntro:"Ne puteți găsi la adresa:",
    contAddr:"Republica Moldova, mun. Ungheni, str. Romană 66/2",
    contPhoneLabel:"Vânzări en-gros și cu amănuntul",
    contEmailLabel:"Comenzi en-gros și oferte comerciale",
    contHoursLabel:"Program oficiu și depozit",
    contOrders:"Comenzile pe site sunt acceptate 24/7",
    yourOrder:"Comanda ta", itemsLabel:"Produse", discountLabel:"Reducere",
    promoCodeLabel:"Cod promo", promoCodePlaceholder:"Introduceți codul", applyPromo:"Aplică", removePromo:"Elimină",
    promoApplied:"Codul promo a fost aplicat", promoDiscountLabel:"Reducere cod promo", promoServerPrice:"Calcul verificat de server",
    promoInvalid:"Codul promo nu este valid sau nu mai este activ.", promoLoginRequired:"Autentificați-vă pentru a folosi acest cod promo.",
    promoLimitReached:"Limita de utilizare a codului promo a fost atinsă.", promoMinOrder:"Suma produselor este sub minimul acestui cod promo.",
    promoNotApplicable:"Codul promo nu se aplică produselor din coș.", promoChanged:"Condițiile codului promo s-au schimbat. Aplicați-l din nou.",
    promoUnavailable:"Verificarea codului promo este temporar indisponibilă.", promoCartChanged:"Coșul s-a schimbat; aplicați din nou codul promo.",
    orderVerifyHuman:"Confirmați verificarea anti-abuz înainte de a plasa comanda.",
    deliveryLabel:"Livrare", freeLabel:"Gratuit",
    agreePre:"Confirm că datele sunt corecte și accept să fiu contactat(ă) pentru această comandă",
    placeOrder:"Finalizează comanda", emptyCheckout:"Coșul tău este gol",
    orderSuccess:"Comanda a fost plasată!",
    orderSuccessText:"Vă mulțumim! Un manager vă va contacta în curând pentru confirmare.",
    orderNo:"Numărul comenzii", continueShopping:"Continuă cumpărăturile",
    reqField:"Câmp obligatoriu", invalidCheckoutEmail:"Introdu o adresă de email validă", invalidCheckoutPhone:"Introdu un număr de telefon valid",
    reqDelivery:"Alege metoda de livrare", reqPayment:"Alege metoda de plată",
    placingOrder:"Se plasează comanda…", orderSubmitError:"Comanda nu a putut fi plasată. Verificați conexiunea și încercați din nou.",
    orderQuoteChanged:"Prețul sau livrarea s-a schimbat. Verificați noul total și confirmați din nou comanda.",
    orderAttemptConflict:"Această încercare de comandă a fost deja folosită cu alte date. Pentru a evita o comandă dublă, nu repetați plata; verificați comenzile din cont sau contactați Nail Mania.",
    newOrderAttempt:"Am verificat: începe o încercare nouă",
    newOrderAttemptConfirm:"Continuați numai dacă ați verificat că prima comandă nu a fost creată. O încercare nouă poate dubla o comandă deja primită. Începeți o încercare nouă?",
    orderUnavailableError:"Comenzile online sunt temporar indisponibile. Coșul a fost păstrat; încercați din nou mai târziu.",
    orderStockError:"Cantitatea disponibilă s-a schimbat. Actualizați coșul și încercați din nou.",
    catalogUnavailableTitle:"Catalog temporar indisponibil",
    catalogUnavailableText:"Nu putem încărca produsele și categoriile actuale. Coșul și favoritele au fost păstrate.",
    retry:"Încearcă din nou"
  },
  ru:{
    topPromo:`Бесплатная доставка по Молдове от ${FREE_DELIVERY_THRESHOLD} лей`,
    hours:"Ежедневно 09:00–18:00",
    workHours:"Пн–Сб 09:00–18:00 · Вс 10:00–16:00",
    catalog:"Каталог", searchPh:"Поиск товаров, брендов…", search:"Найти",
    fav:"Избранное", cart:"Корзина", menu:"Меню", close:"Закрыть",
    removeItem:"Удалить товар", increaseQty:"Увеличить количество", decreaseQty:"Уменьшить количество",
    navNew:"Новинки", navSale:"Скидки", navBrands:"Бренды", navDelivery:"Доставка", navContact:"Контакты", navPayment:"Оплата",
    heroKicker:"Коллекция сезона", heroTitle:"Тренды\nсезона", heroText:"Гель-лаки, базы и топы для мастеров маникюра — всё в одном месте.",
    heroBtn:"Тренды сезона", heroBtn2:"Новинки",
    pillCatalog:"Каталог", pillNew:"Новинки", pillSale:"Скидки",
    catsTitle:"Категории товаров",
    secBest:"Тренды сезона", secNew:"Новое поступление в Nail Mania", secSale:"Товары со скидкой", secSummer:"Акции",
    all:"Все", addCart:"В корзину", inCart:"В корзине ✓", quickAdd:"Быстрый заказ",
    brandsTitle:"Наши бренды", brandsSub:"Работаем только с проверенными производителями",
    allBrands:"Все бренды", filterBrand:"Бренд",
    allCats:"Все категории", filterCat:"Категория",
    deliveryTitle:"Доставка", deliverySub:"Бесплатный самовывоз из магазина или доставка курьером по всей Молдове",
    d1:"Самовывоз из магазина Nail Mania — бесплатно",
    d2:`Курьер по Молдове — ${COURIER_DELIVERY_FEE} лей (бесплатно от ${FREE_DELIVERY_THRESHOLD} лей)`,
    termsTitle:"Сроки доставки",
    t1:"Самовывоз — за ~1 час (заказы до 17:00)",
    t2:"Срок курьерской доставки подтверждает менеджер с учётом населённого пункта",
    contact:"Контакты", emptyCart:"Ваша корзина пуста", emptyFav:"Нет избранных товаров",
    total:"Итого", checkout:"Оформить заказ", clear:"Очистить", goShop:"За покупками",
    footAbout:"Магазин для мастеров маникюра и педикюра в Молдове.",
    colCatalog:"Каталог", colInfo:"Информация", colContact:"Контакты",
    newBadge:"НОВОЕ", saleBadge:"-", off:"скидка",
    results:"результатов", noResults:"Ничего не найдено", pageNotFound:"Страница не найдена", pageNotFoundText:"Проверьте адрес или вернитесь на главную страницу.", featured:"Рекомендуем",
    addedToast:"Добавлено в корзину", stockLimitReached:"Доступный максимум", lei:"лей",
    menuTitle:"Меню", langLabel:"Язык",
    // ---- product page ----
    home:"Главная", inStock:"В наличии", outOfStock:"Нет в наличии", code:"Артикул", qty:"Количество",
    buyOneClick:"Купить в один клик", goCheckout:"К оформлению",
    descTitle:"Описание", charTitle:"Характеристики",
    charBrand:"Бренд", charCat:"Категория", charCode:"Артикул", charAvail:"Наличие",
    relatedTitle:"Похожие товары", notFound:"Товар не найден", backHome:"Назад в магазин",
    descA:"от {brand} — профессиональный продукт из категории «{cat}», созданный для мастеров маникюра и педикюра. Высокое качество, стойкий результат и лёгкое нанесение.",
    descB:"Формула, проверенная в салоне, удобная упаковка и экономичный расход. Закажите сейчас и заберите из магазина или курьером по всей Молдове.",
    // ---- checkout ----
    checkoutTitle:"Оформление заказа", deliverySection:"Доставка",
    chooseDelivery:"Выберите способ доставки",
    courier:"Курьер", courierDesc:"Доставка по адресу по всей Молдове",
    pickup:"Самовывоз из магазина", pickupDesc:"ул. Романэ 66/2, Унгены — бесплатно",
    recipient:"Получатель", fullName:"Имя и Фамилия", phone:"Мобильный телефон",
    emailLabel:"Электронная почта", addressLabel:"Адрес доставки", cityLabel:"Город / Населённый пункт",
    commentLabel:"Комментарий", commentPh:"Комментарий к заказу (необязательно)",
    paymentSection:"Способ оплаты",
    payMia:"MIA", payMiaDesc:"Мгновенная оплата через приложение MIA",
    payCard:"Перевод на карту", payCardDesc:"Банковский перевод на карту",
    payCash:"Наличными при получении", payCashDesc:"Оплата курьеру или в магазине",
    payTitle:"Оплата", payLead:"Оплатить заказ можно несколькими способами:",
    payOnDelivery:"При доставке", payPickup:"При самовывозе из магазина Nail Mania (Унгены)",
    payDel1:"Наличными, напрямую курьеру",
    payDel2:"Наложенный платёж — для заказов через Nova Poshta",
    payPick1:"Наличными",
    payPick2:"Банковской картой",
    payPick3:"Банковским переводом (по счёту)",
    payNote:"Для другого способа (например, если вы за границей) свяжитесь с нами по +373 68 067 486 (WhatsApp, Viber) и укажите выбранный способ в комментарии к заказу.",
    contIntro:"Вы можете найти нас по адресу:",
    contAddr:"Республика Молдова, мун. Унгены, ул. Романэ 66/2",
    contPhoneLabel:"Продажи оптом и в розницу",
    contEmailLabel:"Оптовые заказы и коммерческие предложения",
    contHoursLabel:"График офиса и склада",
    contOrders:"Заказы на сайте принимаются 24/7",
    yourOrder:"Ваш заказ", itemsLabel:"Товары", discountLabel:"Скидка",
    promoCodeLabel:"Промокод", promoCodePlaceholder:"Введите код", applyPromo:"Применить", removePromo:"Удалить",
    promoApplied:"Промокод применён", promoDiscountLabel:"Скидка по промокоду", promoServerPrice:"Расчёт проверен сервером",
    promoInvalid:"Промокод недействителен или больше не активен.", promoLoginRequired:"Войдите в аккаунт, чтобы использовать этот промокод.",
    promoLimitReached:"Лимит использований промокода исчерпан.", promoMinOrder:"Сумма товаров ниже минимальной для этого промокода.",
    promoNotApplicable:"Промокод не действует на товары в корзине.", promoChanged:"Условия промокода изменились. Примените его снова.",
    promoUnavailable:"Проверка промокода временно недоступна.", promoCartChanged:"Корзина изменилась; примените промокод снова.",
    orderVerifyHuman:"Подтвердите антибот-проверку перед оформлением заказа.",
    deliveryLabel:"Доставка", freeLabel:"Бесплатно",
    agreePre:"Подтверждаю правильность данных и согласен(на), чтобы со мной связались по этому заказу",
    placeOrder:"Оформить заказ", emptyCheckout:"Ваша корзина пуста",
    orderSuccess:"Заказ оформлен!",
    orderSuccessText:"Спасибо! Менеджер свяжется с вами в ближайшее время для подтверждения.",
    orderNo:"Номер заказа", continueShopping:"Продолжить покупки",
    reqField:"Обязательное поле", invalidCheckoutEmail:"Введите корректный адрес электронной почты", invalidCheckoutPhone:"Введите корректный номер телефона",
    reqDelivery:"Выберите способ доставки", reqPayment:"Выберите способ оплаты",
    placingOrder:"Оформляем заказ…", orderSubmitError:"Не удалось оформить заказ. Проверьте соединение и попробуйте ещё раз.",
    orderQuoteChanged:"Цена или доставка изменилась. Проверьте новый итог и подтвердите заказ ещё раз.",
    orderAttemptConflict:"Эта попытка заказа уже использовалась с другими данными. Во избежание дубля не повторяйте оплату; проверьте заказы в аккаунте или свяжитесь с Nail Mania.",
    newOrderAttempt:"Я проверил(а): начать новую попытку",
    newOrderAttemptConfirm:"Продолжайте только после проверки, что первый заказ не создан. Новая попытка может продублировать уже принятый заказ. Начать новую попытку?",
    orderUnavailableError:"Онлайн-заказы временно недоступны. Корзина сохранена — попробуйте ещё раз позже.",
    orderStockError:"Доступное количество изменилось. Обновите корзину и попробуйте снова.",
    catalogUnavailableTitle:"Каталог временно недоступен",
    catalogUnavailableText:"Не удалось загрузить актуальные товары и категории. Корзина и избранное сохранены.",
    retry:"Попробовать снова"
  }
};

// ---- Category presentation ----
// Category identity, activity and bilingual names come only from D1. This map is
// presentation metadata for known category ids; unknown D1 categories receive a
// deterministic default style.
const CURATED_CAT_VISUALS = [
  {id:"gellac", g:["#e8c6d4","#f3e0e7"], icon:"bottle"},
  {id:"baze", g:["#f4ddd6","#fbeee9"], icon:"bottle"},
  {id:"topuri", g:["#e7d3e6","#f6eaf4"], icon:"bottle"},
  {id:"alungire", g:["#dcc7e6","#efe2f4"], icon:"tip"},
  {id:"solutii", g:["#cfd9e6","#e9eef4"], icon:"bottle"},
  {id:"bituri", g:["#d9d9de","#eeeef0"], icon:"bit"},
  {id:"instrumente", g:["#d3d6da","#ebecef"], icon:"tool"},
  {id:"lichide", g:["#cfe0e0","#e8f2f2"], icon:"bottle"},
  {id:"sterilizare", g:["#c9dbe8","#e6eef5"], icon:"box"},
  {id:"epilare", g:["#f0e3c8","#f9f1de"], icon:"box"},
  {id:"pedichiura", g:["#e9cdbf","#f6e4da"], icon:"foot"},
  {id:"tehnica", g:["#dcd2e0","#efe9f2"], icon:"lamp"},
  {id:"accesuare", g:["#e7d6dd","#f5ebef"], icon:"box"},
  {id:"sprancene", g:["#e4d3cb","#f3e7e1"], icon:"brow"},
  {id:"gene", g:["#ddd0cf","#f0e7e6"], icon:"brow"},
  {id:"ingrijire", g:["#f0dce2","#fbeef2"], icon:"bottle"},
  {id:"materiale", g:["#dfe0e2","#f1f1f3"], icon:"box"},
  {id:"design", g:["#e7c9dd","#f6e7f1"], icon:"sparkle"},
  {id:"slidiz", g:["#cfe0ea","#e9f1f7"], icon:"sparkle"}
];
// auto-styling for categories that aren't curated above
const CAT_PALETTE = [["#e8c6d4","#f3e0e7"],["#cfe0e0","#e8f2f2"],["#e7d3e6","#f6eaf4"],["#f0e3c8","#f9f1de"],["#cfd9e6","#e9eef4"],["#e9cdbf","#f6e4da"],["#dfe0e2","#f1f1f3"],["#ddd0cf","#f0e7e6"]];
const _hh = (s)=>{ let h=0; for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))>>>0; return h; };
const _curatedById = Object.fromEntries(CURATED_CAT_VISUALS.map(c=>[c.id,c]));
export function decorateCategory(row){
  const id = String(row.id);
  const curated = _curatedById[id];
  return {
    id,
    slug:String(row.slug || id),
    ro:String(row.name_ro),
    ru:String(row.name_ru || row.name_ro),
    seoTitleRo:String(row.seo_title_ro || ''),
    seoTitleRu:String(row.seo_title_ru || ''),
    seoDescriptionRo:String(row.seo_description_ro || ''),
    seoDescriptionRu:String(row.seo_description_ru || ''),
    productCount:Number(row.product_count || 0),
    sortOrder:Number(row.sort_order || 0),
    g:curated?.g || CAT_PALETTE[_hh(id)%CAT_PALETTE.length],
    icon:curated?.icon || "box",
    img:categoryImage(id),
  };
}

// ---- Products come from the real price list in catalog-data.js ----

// ---- Local images ----
// Relative photo paths supplied by the catalog are resolved under public/.
// Products without a catalog photo use the gradient Placeholder without issuing
// a speculative request for a file that may not exist.
const BASE = (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.BASE_URL) || "/";
export const asset = (p)=> BASE + String(p).replace(/^\//,"");
export const catImg = (id)=> asset(`images/categories/${id}.jpg`);
// gallery: only the images we actually have (no empty placeholder slots).
// p.image may hold one URL or several separated by whitespace.
export const productGallery = (p)=>{
  if(p.image){
    // absolute URLs (supplier) pass through; relative local paths get BASE via asset()
    const urls = catalogImageUrls(p.image)
      .map(u=> /^(https?:|data:|\/\/)/.test(u) ? u : asset(u));
    if(urls.length) return urls;
  }
  return [];
};
export const HERO_IMG = [
  asset("images/hero-main.webp"),
  asset("images/hero-promo.webp"),
  asset("images/hero-sale.webp"),
];
export const ABOUT_IMG = asset("images/about.jpg");

// Category thumbnails, in priority order:
//   1. generated category art in src/cat-images-ai/<id>.<ext>
//   2. local images/categories/<id>.jpg -> gradient placeholder
const _catGenerated = import.meta.glob('./cat-images-ai/*.{jpg,jpeg,png,webp}', { eager: true, query: '?url', import: 'default' });
const _catImgById = {};
for (const [p, url] of Object.entries(_catGenerated)) _catImgById[p.replace(/^.*\//, '').replace(/\.[^.]+$/, '')] = url;
export const categoryImage = (id)=> _catImgById[id] || catImg(id);
