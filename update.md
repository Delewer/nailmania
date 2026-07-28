# Nail Mania — актуальный статус завершения проекта

Дата проверки: 28 июля 2026 года.

## Итог

Локальная реализация проекта по исходному плану завершена и проходит технические проверки. Production ещё не переключён: read-only smoke 28 июля 2026 года подтвердил, что `https://nailmania.md/api/products?limit=1` всё ещё возвращает HTML старого статического приложения. Preview endpoint возвращает старый каталог из 1846 товаров, а `/api/admin/session` — `503 ADMIN_AUTH_NOT_CONFIGURED`; новый artifact из 1874 товаров туда не публиковался. Read-only status обеих удалённых D1 28 июля подтвердил: применены только migrations 0001–0004, а 0005–0013 ожидают guarded rollout.

Табличный блокер снят: свежая Google Sheet прошла обязательный source gate, каталог пересобран и проверен на чистой local D1. Production-релиз всё ещё не готов из-за внешних настроек Cloudflare/R2/Access, отсутствующей preview-авторизации и обязательной preview-приёмки. Старый внешний механизм публикации определённо продолжает создавать production deployments source `2333564`: 28 июля новые deployments появились 4–7 часов назад. Точный источник нужно проверить в Script Properties и Pages Deploy Hooks. Git/GitHub владелец ведёт самостоятельно.

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
- R2 helpers требуют точную среду и bucket из `wrangler.toml`, повторное подтверждение bucket, чистый SHA, production `main` и явный HTTPS public base; production `*.r2.dev` запрещён из-за rate limiting, частичная загрузка завершается ошибкой без частичной перезаписи tracked catalog.
- Перед первой migration промокодов remote preflight останавливает релиз при любых legacy `promo_redemptions`.
- Pages release gate проверяет branch/HEAD/чистый worktree, точный digest `dist`, build manifest, environment-specific bundle и D1 migration/catalog evidence той же среды и commit; production требует принятую preview-аттестацию того же commit. Scheduled Worker собирается и разворачивается отдельным guard с digest исходника, bundle, entrypoint и конфигурации, а deploy требует соответствующий D1 migration evidence. Обезличенные acceptance/load/browser JSON-отчёты проверяются на sensitive data и атомарно пишутся только в `tmp/reports`; catalog и release evidence остаются в своих выделенных игнорируемых каталогах под `tmp`.
- Критический `functions/_middleware.js` больше не игнорируется Git и проходит tracking-eligibility verifier; включить его вместе с остальными новыми файлами в будущий commit должен владелец repository.

Подробности: `docs/RELEASE.md`, `docs/OPERATIONS.md`, `docs/STATISTICS.md`.

## Доказательства локальной проверки

Успешно на 28 июля 2026 года:

- `npm test`: 193/193, включая order concurrency, free-delivery threshold, catalog integrity и release guards;
- production Vite 8/SEO build и Pages Functions compile через Wrangler 4.114;
- Scheduled Worker preview и production dry-run;
- release config: 13 migrations, изолированные preview/production D1, R2 и Analytics Engine;
- все 13 migrations применены с нуля к чистой local D1;
- в чистую local D1 импортирован текущий validated catalog: 17 категорий, 1874 товара, 1874 строки inventory, 6107 единиц и 2503 image rows, без unexpected import categories, invalid inventory и orphan active products;
- `npm run audit:security` проходит fail-closed policy: единственное принятое upstream npm advisory относится к неиспользуемым нестабильным React Server Components, а проект работает через declarative `BrowserRouter` и тестом запрещает RSC API;
- load check: 120/120 запросов, 0 ошибок, p50 90 мс, p95 209 мс, p99 276 мс, max 283 мс; обезличенный отчёт — `tmp/reports/local-load-final-20260728.json`;
- реальный loopback HTTP acceptance: каталог, product, sitemap, admin session, временный 50% promo, server quote, заказ ровно на 2200 лей, `deliveryFee=0`, резерв, notification journal, internal comment revision, отмена, восстановление availability, release redemption, statistics/readiness; обезличенный отчёт — `tmp/reports/local-acceptance-final-20260728.json`;
- acceptance завершил заказ в `cancelled` и деактивировал временный промокод; audit/journal намеренно сохранены как доказательство;
- после acceptance повторная проверка D1 подтвердила 13 migrations, 17 категорий, 1874 товара и 1874 строки inventory.

Standalone Chrome browser smoke выполнен на loopback после финальной production-сборки: 12/12 страниц (главная, товар, checkout, настоящий 404, customer login и admin login при 1440 и 390 px), 0 horizontal overflow, 0 page/JS errors и 0 неожиданных failed responses. Все четыре аналитических `POST` заблокированы до сети, `serverWriteRequestsSent=0`; корзина создавалась только в изолированном `localStorage`. Обезличенный отчёт — `tmp/reports/browser-smoke-20260728.json`, PNG — `tmp/browser-smoke/run-2026-07-28T13-20-33-882Z-10116`. Это не заменяет обязательный ручной mobile/desktop/provider/Access smoke на preview.

## Каталог: текущий source gate пройден

Свежая опубликованная Google Sheet проверена 28 июля 2026 года в 16:17 по Кишинёву строгой загрузкой с cache-buster:

- 1874 строки и 1874 уникальных SKU;
- 6107 единиц;
- 0 ошибок и 39 предупреждений;
- snapshot: `tmp/catalog-source.csv`;
- report: `tmp/catalog-validation.json`;
- source SHA-256: `f9e436bfcb54887bc033a893f5eb0dd71c669f407335960f8a22d3f7fb942fa1`.

Предупреждения не блокируют сборку: 33 товара без описания и 6 товаров без фото (`T3271`, `T3268`, `T3269`, `T3270`, `T3272`, `T3273`).

Из точных validated bytes собраны и взаимно сверены:

- catalog SHA-256: `36a5ac58c8ac3c812d9c875be2e4679ed1bbb97927140521b782a0742016e4a6`;
- categories SHA-256: `db6c1a95f35639c2dc70cc29b38bbea08b7b9bef1413a701e1b03d1c1a3b049c`;
- import SQL SHA-256: `ac99f9a520ea40eb52fa99297a30425b8d6dbe95f24eec90dba31165449ac365`;
- `tmp/catalog-build-integrity.json` и `tmp/d1/catalog-import-validation.json`: `valid: true`, `errorCount: 0`.

Независимая QA подтвердила отсутствие duplicate SKU/key/id, пустых обязательных полей, invalid price/stock/URL и category mismatch. Для необязательной ручной бизнес-проверки отмечены необычный, но валидный SKU `T333331` и две пары одинаково названных позиций с разными SKU/изображениями: `T1925`/`T1932` и `T0988`/`T1028`.

Все 13 migrations и текущий catalog artifact применены с нуля к изолированной local D1: 17 активных import-категорий, 1874 активных import-товара, 1874 строки inventory, 6107 единиц и 2503 строки изображений; неожиданных активных import-категорий, invalid inventory и orphan active products нет.

Catalog artifact технически валиден и локально готов к guarded preview import. При этом 2368 из 2503 image rows всё ещё используют rate-limited `*.r2.dev`, ещё 135 rows — внешние hosts; перед production нужен утверждённый canonical image host. Удалённые D1 локальной проверкой не изменялись.

## Что остаётся сделать вне кода

1. Утвердить production R2 bucket и custom domain. Read-only Cloudflare-аудит 18 июля показал: `nailmania-photos` содержит 3252 объекта (518 MB) и доступен по прежнему `pub-bdc…r2.dev`; `nailmania-product-images-preview` и `nailmania-product-images-production` пусты, custom domains отсутствуют. 25 июля повторно подтверждено наличие всех трёх bucket. HEAD-аудит прежнего snapshot получил 879 успешных ответов, после чего `r2.dev` начал массово отвечать `429`, поэтому этот host больше не допустим как production canonical. В текущем valid catalog artifact 2503 D1 image rows на 40 hosts: 2368 строк используют `pub-bdc9e7e148164007b19e2753ba1b49b9.r2.dev`, ещё 135 — внешние hosts; после глобальной дедупликации это 2112 уникальных HTTP URL (1993 + 119). Практичный первый rollout: подключить `images.nailmania.md` к наполненному production bucket, переписать catalog на custom domain и отдельно rehost внешние URL; preview должен проверить те же immutable URL. Выбор между использованием `nailmania-photos` как production binding и миграцией его объектов в новый production bucket требует подтверждения владельца до изменения `wrangler.toml`/Cloudflare.
2. Предоставить утверждённые юридические тексты и данные владельца для условий покупки, конфиденциальности и возвратов. Фиктивная ссылка `href="#"` удалена, но выдумывать legal content нельзя.
3. Git/GitHub владелец настраивает самостоятельно. В рамках этой работы repository, права, branch protection, commit и push не изменяются. В будущий commit обязательно включить новые tracking-eligible `functions/_middleware.js` и `functions/brand/[name].js`; release verifier отдельно останавливается, если middleware отсутствует или игнорируется.
4. Найти и отключить старую внешнюю публикацию: read-only аудит 28 июля снова обнаружил много production deployments одного и того же старого source `2333564`; новые deployments появились 4–7 часов назад. Это сильный признак активного внешнего механизма, но не доказательство его точного источника. Проверить Script Properties и Pages Deploy Hooks; если там есть `DEPLOY_HOOK_URL`/старый hook, отключить их и подтвердить отсутствие нового deployment после контрольного изменения Sheet.
5. Настроить Cloudflare Access на точные `/admin`, `/admin/*`, `/api/admin`, `/api/admin/*`; добавить второго администратора и отдельную preview policy/AUD.
6. Настроить R2 public domain, runtime vars и encrypted secrets без значений в Git:
   - `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `R2_PUBLIC_BASE_URL`;
   - `AUTH_FINGERPRINT_SALT`, `RATE_LIMIT_SECRET`;
   - `TURNSTILE_SECRET_KEY` и build-time `VITE_TURNSTILE_SITE_KEY`;
   - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`;
   - email transport/token и `CUSTOMER_PASSWORD_RESET_URL`;
   - `ANALYTICS_INDEX_SECRET`, `CLOUDFLARE_ACCOUNT_ID`, `ANALYTICS_READ_TOKEN`;
   - preview/production Analytics Engine binding/dataset уже описаны в `wrangler.toml`.
   - read-only список именно Pages encrypted secrets 25 июля содержит только `R2_ACCESS_KEY_ID`, `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_SECRET_ACCESS_KEY`, `TELEGRAM_BOT_TOKEN`. S3 management credentials приложению не нужны и после R2 maintenance должны быть удалены из Pages; остальные обязательные runtime vars/secrets нужно настроить и подтвердить через readiness.
7. Рекомендуется Workers Paid; иначе preview load обязан подтвердить запас CPU/D1 на выбранном плане.
8. С текущим validated catalog artifact — по `docs/RELEASE.md`: восстановить Cloudflare API-авторизацию, сделать backup preview, заново проверить pending migrations, применить migrations 0005–0013, импортировать artifact только через guarded wrapper, выполнить guarded release build с preview Turnstile site key, deploy preview Worker/Pages и выполнить Access/mobile/desktop/provider acceptance.
9. Только после принятого preview SHA: свежий production backup/bookmark, guarded migrations/catalog import/release build, production deploy и smoke.

С нашей стороны никакой production deploy, remote D1 mutation, push или изменение GitHub/Cloudflare настроек в этой работе не выполнялись. Обнаруженные параллельные deployments созданы внешним существующим механизмом, а не командами этого release-процесса.

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
