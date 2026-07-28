# Nail Mania — актуальный статус завершения проекта

Дата проверки: 28 июля 2026 года.

## Итог

Локальная реализация проекта по исходному плану завершена и проходит технические проверки. Production ещё не переключён: `https://nailmania.md/api/products?limit=1` всё ещё обслуживается старым статическим приложением. Последний preview развёрнут из SHA `2e165736af024a4a3033cd0d384ae6a14f9cfc5f`, защищён Cloudflare Access и использует preview D1 со всеми 13 migrations, 17 категориями, 1874 товарами, 1874 строками inventory, 6098 единицами и 2503 строками изображений. Текущие R2/image-policy изменения появились после этого SHA и в preview ещё не развёрнуты и формально не приняты. Production D1 по-прежнему имеет только migrations 0001–0004; 0005–0013 ожидают отдельный guarded rollout.

Табличный блокер снят: свежая Google Sheet прошла обязательный source gate, каталог пересобран и проверен на чистой local D1. Для production выбран наполненный bucket `nailmania-photos`, активирован `https://images.nailmania.md`, а production Pages binding и `R2_PUBLIC_BASE_URL` подготовлены для следующего deployment. Все legacy URL текущего локального каталога уже канонизированы; остаётся безопасно перенести 119 уникальных внешних URL и повторить preview-приёмку нового SHA. Автоматические production deployments отключены, preview branch deployments выставлены в `None`, Deploy Hooks удалены. Git/GitHub владелец ведёт самостоятельно.

Главный бизнес-инвариант реализован на клиенте и сервере:

- курьерская доставка стоит 70 лей;
- если стоимость товаров после скидок каталога равна или превышает 2200 лей, доставка бесплатна;
- порог считается до промокода, поэтому промокод не отменяет уже полученную бесплатную доставку;
- сервер всегда пересчитывает цену и остаток сам;
- если показанная покупателю сумма успела измениться, заказ не создаётся: API возвращает `409 ORDER_QUOTE_CHANGED`, checkout показывает новый расчёт и требует явного повторного подтверждения;
- D1 trigger повторно сверяет цену и весь коммерческий snapshot внутри атомарной записи заказа; изменение товара/категории или исчезновение строки inventory между расчётом и batch полностью откатывает заказ и резерв;
- после конфликтующего batch актуальная quote/replay читается через новую `first-primary` D1 session, поэтому replica lag не возвращает устаревший расчёт.

## Что реализовано

### Каталог, D1 и SEO

- D1 является единственным runtime-источником каталога; статического fallback при сбое API нет.
- Публичные категории, товары, бренды, карточки, поиск, sitemap и server-rendered SEO/JSON-LD читают D1.
- Cache API использует короткий TTL и D1 revision; изменения каталога, остатков, заказов и возвратов инвалидируют старый ключ.
- Прямые product/category/brand routes отдают D1-derived canonical/JSON-LD, неизвестные маршруты и отсутствующие сущности возвращают настоящий HTTP `404` с `noindex`, а checkout/auth/account/admin/search HTML shells — `noindex` и `no-store` ещё до запуска JavaScript.
- Импорт Google Sheet строгий и воспроизводимый: snapshot, SHA-256, JSON-отчёт, стабильный SKU/key и отказ до записи при любой ошибке.
- Importer не перезаписывает администраторские карточки/категории/остатки.
- Обычный `npm run build` больше не запускает загрузку изображений в R2. `npm run rehost` — только отдельное осознанное действие.

### Заказы, склад и доставка

- Legacy `/api/order` и PHP endpoint возвращают `410 Gone`; checkout работает только через D1 `POST /api/orders`.
- Создание заказа, резерв, строки заказа, складские движения, промокод и idempotency record фиксируются одним D1 batch.
- UUID v4 idempotency key сохраняется клиентом до успеха. Потерянный HTTP-ответ и повтор не создают второй заказ, резерв, redemption или уведомление.
- Один ключ с другим намерением отклоняется; committed replay разрешён до повторной проверки одноразового Turnstile только после same-origin, principal и HMAC-SHA-256 fingerprint проверки.
- Публичный order/idempotency response и гостевой `localStorage` не содержат имя, телефон, email или адрес. Старый `nm_orders` удаляется при загрузке; внутренний комментарий не копируется в audit JSON.
- Quote v1 включает каждую строку, цены, catalog discount, delivery, promo и total; скрытый repricing невозможен.
- Конкурентная покупка последней единицы, ручная правка склада и возврат защищены revision/conditional SQL.
- Клиент ограничивает строку корзины текущим остатком и максимумом 99 единиц, блокирует `+` на пределе и повторно сжимает корзину после обновления каталога; сервер объединяет повторяющиеся SKU до проверки, поэтому дубли не обходят лимит 99 или остаток.
- D1-лимиты учтены: statements не превышают 100 bind-параметров; возврат 50 SKU укладывается в 18 D1 queries и максимум 98 binds.
- Поиск ограничивает `LIKE` pattern до 50 UTF-8 bytes, включая кириллицу и emoji.
- Статусы заказа, 24-часовой резерв, scheduled expiry, продажа, отмена, полный и частичный возврат идемпотентны и журналируются.

### Аккаунты и админка

- Регистрация, вход, выход, opaque HttpOnly sessions, PBKDF2 password hashing, reset по одноразовой ссылке, адреса, история заказов и повтор заказа.
- Разделы admin: заказы, товары, категории, складской журнал, возвраты, промокоды, статистика и audit log. Роль `manager` обслуживает заказы/каталог/склад/возвраты, но не имеет доступа к промокодам, статистике, audit log и readiness; эти разделы доступны только `admin`. В ответах заказов для `manager` скрыты точные promo code/id, остаётся только нужная для возвратов сумма скидки.
- Cloudflare Access JWT проверяется до активной D1-роли `manager/admin`; локальный bearer token работает только при `ENVIRONMENT=local`.
- Изображения проверяются по реальным JPEG/PNG/WebP/AVIF bytes и пишутся в R2.
- Все административные mutation требуют same-origin и оставляют audit trail; важные редактирования защищены optimistic revision.
- Storefront, checkout, account и admin получили keyboard/focus/ARIA-семантику, mobile layouts, связанные labels/errors и безопасную работу при недоступном `localStorage`.

### Промокоды

- Percent/fixed, даты, min/max суммы, total/per-user limits, category/product scopes и включение/выключение.
- Лимиты сериализуются D1 triggers; отмена и expiry освобождают redemption.
- Исторический `code_snapshot` не меняется после переименования промокода.
- Частичный/полный возврат реверсирует точную сохранённую allocation скидки.
- Checkout RO/RU умеет применить/снять код и показывает серверные суммы/ошибки.

### Статистика и аналитика

- UTC-периоды `[from,to)`, продажи по `completed_at`, возвраты по immutable `order_returns.created_at`.
- Revenue, refund, net, average check, units, COGS, gross profit и текущая стоимость склада.
- Исторические category/cost snapshots не меняются после редактирования товара.
- CSV sales/products/inventory/movements: UTF-8 BOM, quoted cells и защита от spreadsheet formula injection.
- Analytics Engine preview/production разнесены по dataset. Публичный endpoint принимает только строгие privacy-safe события; raw search, PII и клиентский `order_created` запрещены.
- Сервер пишет `order_created` только после D1 commit. Анонимный HMAC index ротируется ежедневно.

### Безопасность, уведомления и эксплуатация

- Turnstile проверяет action/hostname; production без secret fail-closed. Deploy-сборка дополнительно требует реальный `VITE_TURNSTILE_SITE_KEY`, чистый SHA и проверяет, что ключ действительно встроен в `dist`. Node закреплён на `24.x` с `engine-strict`; любые другие `VITE_*` process/env-file inputs запрещены и их точный контракт записывается в build manifest.
- D1 rate limit использует HMAC identity, request IDs и structured logs.
- Публичные customer/promo/order JSON endpoints требуют same-origin и точный `application/json`, ограничивают streaming body до 16/32/64 KiB и возвращают `413` до бизнес-логики при превышении лимита.
- Telegram/email попытки и outcomes append-only и не содержат customer payload, токены, chat ID или provider body.
- Telegram выполняется после commit и не отменяет успешный заказ.
- Pending notification имеет lease 5 минут. После аварийного завершения он получает `NOTIFICATION_ATTEMPT_EXPIRED`, а deterministic recovery создаётся ровно один раз; ручной resend доступен после lease.
- Readiness endpoint возвращает только boolean checks для D1, Access, secrets, R2, email, Telegram и Analytics; deployment считается неготовым, если в Pages runtime попали лишние S3 management credentials вместо одного R2 binding либо production image base всё ещё использует `*.r2.dev`.
- D1 release wrappers требуют чистый Git SHA, точное имя базы и для preview/production свежий backup с проверенными SQL/Time Travel checksums. Имена и содержимое всех 13 migrations защищены checksum manifest; remote catalog import после записи сверяет точные postconditions и сохраняет evidence. Прямые remote catalog/admin helpers отключены.
- R2 helpers требуют точную среду и bucket из `wrangler.toml`, повторное подтверждение bucket, чистый SHA, production `main` и явный HTTPS public base. Catalog rehost разрешён только для exact production bucket/host; DNS и literal IP проверяются против private/loopback/link-local/unspecified/multicast ranges на каждом redirect, выбранный публичный IP закрепляется на запрос, ответ ограничен 20 MiB и проверяется по реальным JPEG/PNG/WebP/GIF/AVIF bytes. Частичная загрузка и параллельное изменение tracked catalog/map завершаются ошибкой без их stale-перезаписи.
- Перед первой migration промокодов remote preflight останавливает релиз при любых legacy `promo_redemptions`.
- Pages release gate проверяет branch/HEAD/чистый worktree, точный digest `dist`, build manifest, environment-specific bundle и D1 migration/catalog evidence той же среды и commit; production требует принятую preview-аттестацию того же commit. Scheduled Worker собирается и разворачивается отдельным guard с digest исходника, bundle, entrypoint и конфигурации, а deploy требует соответствующий D1 migration evidence. Обезличенные acceptance/load/browser JSON-отчёты проверяются на sensitive data и атомарно пишутся только в `tmp/reports`; catalog и release evidence остаются в своих выделенных игнорируемых каталогах под `tmp`.
- Критические `functions/_middleware.js` и `functions/brand/[name].js` отслеживаются Git и проходят tracking-eligibility verifier.

Подробности: `docs/RELEASE.md`, `docs/OPERATIONS.md`, `docs/STATISTICS.md`.

## Доказательства локальной проверки

Успешно на 28 июля 2026 года для текущего worktree:

- `npm test`: 214/214, включая order concurrency, free-delivery threshold, catalog integrity, image policy/SSRF guards и release guards;
- production Vite 8/SEO build и Pages Functions compile через Wrangler 4.114;
- Scheduled Worker preview и production dry-run;
- release config: 13 migrations, изолированные preview/production D1, R2 и Analytics Engine;
- все 13 migrations применены с нуля к чистой local D1;
- в чистую local D1 импортирован текущий validated catalog: 17 категорий, 1874 товара, 1874 строки inventory, 6098 единиц и 2503 image rows, без unexpected import categories, invalid inventory и orphan active products;
- `npm run audit:security` проходит fail-closed policy: единственное принятое upstream npm advisory относится к неиспользуемым нестабильным React Server Components, а проект работает через declarative `BrowserRouter` и тестом запрещает RSC API;
- load check: 120/120 запросов, 0 ошибок, p50 90 мс, p95 209 мс, p99 276 мс, max 283 мс; обезличенный отчёт — `tmp/reports/local-load-final-20260728.json`;
- реальный loopback HTTP acceptance: каталог, product, sitemap, admin session, временный 50% promo, server quote, заказ ровно на 2200 лей, `deliveryFee=0`, резерв, notification journal, internal comment revision, отмена, восстановление availability, release redemption, statistics/readiness; обезличенный отчёт — `tmp/reports/local-acceptance-final-20260728.json`;
- acceptance завершил заказ в `cancelled` и деактивировал временный промокод; audit/journal намеренно сохранены как доказательство;
- после acceptance повторная проверка D1 подтвердила 13 migrations, 17 категорий, 1874 товара и 1874 строки inventory.

Standalone Chrome browser smoke выполнен на loopback для последнего предшествующего R2 SHA: 12/12 страниц (главная, товар, checkout, настоящий 404, customer login и admin login при 1440 и 390 px), 0 horizontal overflow, 0 page/JS errors и 0 неожиданных failed responses. Все четыре аналитических `POST` заблокированы до сети, `serverWriteRequestsSent=0`; корзина создавалась только в изолированном `localStorage`. Обезличенный отчёт — `tmp/reports/browser-smoke-20260728.json`, PNG — `tmp/browser-smoke/run-2026-07-28T13-20-33-882Z-10116`. Это не заменяет обязательный ручной mobile/desktop/provider/Access smoke на новом preview SHA.

## Каталог: текущий source gate пройден

Свежая опубликованная Google Sheet проверена 28 июля 2026 года в 18:41 по Кишинёву строгой загрузкой с cache-buster:

- 1874 строки и 1874 уникальных SKU;
- 6098 единиц;
- 0 ошибок и 39 предупреждений;
- snapshot: `tmp/catalog-source.csv`;
- report: `tmp/catalog-validation.json`;
- snapshot size: 892402 bytes;
- source SHA-256: `7169f17d9f51cdd76346a0f382422c5798945ae2102c405b33b066df7ecd1333`.

Предупреждения не блокируют сборку: 33 товара без описания и 6 товаров без фото (`T3271`, `T3268`, `T3269`, `T3270`, `T3272`, `T3273`).

Из точных validated bytes собраны и взаимно сверены:

- промежуточный catalog SHA-256 до external rehost: `97b2a0c1671946658fbe743f99e984b5fc6842e9a8c71e13cb0b9cc2e344d1f5`;
- categories SHA-256: `db6c1a95f35639c2dc70cc29b38bbea08b7b9bef1413a701e1b03d1c1a3b049c`;
- промежуточный import SQL SHA-256 до external rehost: `b560b1632ccc98239f3e0f6ba27aed3f983a8e08ef17e440288afd985a69588c`;
- `tmp/catalog-build-integrity.json` и `tmp/d1/catalog-import-validation.json`: `valid: true`, `errorCount: 0`.

Независимая QA подтвердила отсутствие duplicate SKU/key/id, пустых обязательных полей, invalid price/stock/URL и category mismatch. Для необязательной ручной бизнес-проверки отмечены необычный, но валидный SKU `T333331` и две пары одинаково названных позиций с разными SKU/изображениями: `T1925`/`T1932` и `T0988`/`T1028`.

Все 13 migrations и текущий catalog artifact применены с нуля к изолированной local D1: 17 активных import-категорий, 1874 активных import-товара, 1874 строки inventory, 6098 единиц и 2503 дедуплицированные строки изображений; неожиданных активных import-категорий, invalid inventory и orphan active products нет.

В исходном catalog artifact 2504 вхождения URL: 2369 уже используют `https://images.nailmania.md`, 0 используют legacy `*.r2.dev`, ещё 135 вхождений соответствуют 119 уникальным внешним URL. Все 1993 уникальных legacy-пути существуют в `nailmania-photos`; path/query при смене origin сохранены точно. Tracked map внешних URL пока пуст, поэтому catalog и SQL hashes выше промежуточные. Preview D1 всё ещё содержит предыдущие URL и должна быть повторно импортирована только после завершения external rehost. Production D1 локальной проверкой не изменялась.

## Что остаётся сделать вне кода

Уже закрыто: owner выбрал `nailmania-photos`; bucket содержит 3276 объектов (около 519 MB). Custom domain `images.nailmania.md` активен, ownership и SSL имеют статус `active`, minimum TLS — 1.2. Проверенные объекты возвращают `200`, правильный image MIME и immutable cache; контрольный объект байт-в-байт совпал со старым URL. Production Pages binding `PRODUCT_IMAGES` и `R2_PUBLIC_BASE_URL` уже указывают на этот bucket/domain и вступят в силу только при следующем production deployment. Старый `r2.dev` пока оставлен включённым до завершения проверки. Автоматические production/preview branch deployments отключены, Deploy Hooks отсутствуют; после следующего контрольного изменения Sheet нужно убедиться, что старый source `2333564` больше не создаёт deployment.

1. Владелец Git должен закоммитить текущую image-policy подготовку и перенести её в чистую ветку `main`. Только из точного clean `main` guard разрешит production-only rehost: скачать 119 уникальных внешних URL, проверить bytes/MIME/размер/адреса назначения, загрузить около 116 уникальных content-addressed объектов и атомарно записать tracked URL map. Для единственного прежнего сбоя `T1795` уже выбран и визуально проверен рабочий источник. Эта операция меняет R2 и tracked catalog/map, но сама по себе не выполняет Pages deploy или D1 mutation.
2. После rehost закоммитить обновлённые `catalog-image-url-map.json` и catalog artifact, заново получить финальные hashes, импортировать его в чистую local D1 и повторить весь локальный gate. Release build должен fail-closed, пока в catalog остаётся хотя бы один внешний image host.
3. Предоставить утверждённые юридические тексты и данные владельца для условий покупки, конфиденциальности и возвратов. Фиктивная ссылка `href="#"` удалена, но выдумывать legal content нельзя.
4. Довести runtime-конфигурацию без значений в Git. Preview Access/AUD настроены; в preview D1 активны роли `admin` и отдельный продавец с ролью `manager`, которая не видит промокоды, статистику, audit log и readiness. Нужно формально проверить вход обоих администраторов и продавца, а перед production утвердить staff matrix и production Access. Помимо уже установленного R2 binding/base должны быть подтверждены readiness-параметры `CF_ACCESS_*`, `AUTH_FINGERPRINT_SALT`, `RATE_LIMIT_SECRET`, Turnstile, Telegram, email/reset и Analytics. Четыре S3/R2 management credentials приложению не нужны и после rehost должны быть удалены из Pages secrets.
5. После нового commit: создать свежий preview backup, подтвердить отсутствие pending migrations, импортировать финальный catalog через guarded wrapper, собрать и развернуть Scheduled Worker и Pages из одного SHA, затем выполнить Access/mobile/desktop/provider acceptance для обоих администраторов и продавца.
6. Рекомендуется Workers Paid; иначе preview load обязан подтвердить запас CPU/D1 на выбранном плане.
7. Только после принятого preview SHA: свежий production backup/bookmark, guarded migrations 0005–0013, catalog import/release build, production Worker/Pages deploy и smoke.

Production Pages и production D1 в ходе этой подготовки не разворачивались и не изменялись. Были изменены только безопасные Cloudflare-настройки до deployment: R2 custom domain, production Pages R2 binding/base и управление автоматическими deployments/hooks. Preview D1/Pages и staff roles были подготовлены ранее на SHA `2e165736…`; текущие image-policy изменения пока не закоммичены и изменят release SHA.

## Git/GitHub — зона ответственности владельца

Решение владельца от 18 июля 2026 года: дальнейшие действия с Git и GitHub он выполняет самостоятельно; повторного решения от него для локальной работы не требуется.

Git нужен: он даёт историю, точный release SHA, code review и безопасный откат. GitHub не обязан быть публичным.

Публичность позволяет любому читать и копировать код, но сама по себе не даёт право менять ваш repository или production. Для записи нужны выданные права/скомпрометированный аккаунт или credential. Тем не менее для магазина private repository разумнее: он уменьшает раскрытие архитектуры и риск случайной публикации конфигурации.

На момент read-only GitHub API проверки 17 июля 2026 года `Delewer/nailmania` был public; `Delewer` имел admin, `ArturTI225` — push, других collaborators не было; `main` не был защищён и repository rulesets отсутствовали. Secret scanning и push protection были включены. Открытых secret alerts, Actions secrets, deploy keys и webhooks было 0. Текущее состояние GitHub после решения владельца отдельно не перепроверялось.

Реальных Telegram tokens/типовых private keys в рабочем дереве и Git history не найдено. `.env*`, `.dev.vars*`, Wrangler state, backups и временные файлы игнорируются. Если какой-либо token когда-либо отправлялся в чат, скриншот, чужой компьютер или публичное место вне Git, его всё равно следует перевыпустить.

Открытые эксплуатационные риски после релиза:

- Telegram timeout не может доказать, принял ли provider сообщение; ручной retry иногда способен доставить дубликат;
- распределённые боты могут статистически загрязнять публичные analytics events, хотя Origin/schema/rate limit уменьшают риск;
- readiness проверяет наличие конфигурации, а не реальную валидность внешних credentials — поэтому preview smoke обязателен.
