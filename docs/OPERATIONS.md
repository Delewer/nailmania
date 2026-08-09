# Nail Mania operational readiness

Этот документ перечисляет runtime-настройки без их значений. Значения секретов не должны попадать в Git, логи, CI artifacts или D1.

## Обязательные production bindings и secrets

- `DB` — production D1 binding.
- `PRODUCT_IMAGES` — production R2 binding.
- `PRODUCT_ANALYTICS` — production Analytics Engine binding; dataset name in `PRODUCT_ANALYTICS_DATASET` must match the committed production binding.
- `R2_PUBLIC_BASE_URL` — HTTPS base URL публичной выдачи изображений. В production обязателен custom domain; `*.r2.dev` запрещён release guard из-за rate limiting.
- `CF_ACCESS_TEAM_DOMAIN` и `CF_ACCESS_AUD` — настройки Cloudflare Access для административного API.
- `AUTH_FINGERPRINT_SALT` — отдельный случайный secret длиной не менее 16 символов для session fingerprint и HMAC-защиты order idempotency intent.
- `RATE_LIMIT_SECRET` — другой независимый случайный secret длиной не менее 16 символов.
- `ANALYTICS_INDEX_SECRET` — отдельный случайный secret длиной не менее 16 символов для дневного анонимного HMAC индекса событий.
- `CLOUDFLARE_ACCOUNT_ID` — 32-символьный ID аккаунта и `ANALYTICS_READ_TOKEN` — Secret только с правом `Account Analytics: Read` для административного event dashboard.
- `TURNSTILE_SECRET_KEY` — production Turnstile secret; frontend отдельно получает соответствующий `VITE_TURNSTILE_SITE_KEY` во время build.
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` и `TELEGRAM_SECONDARY_CHAT_ID` — параметры Telegram delivery для основного и дополнительного получателя. Для приватности все три следует задавать через Cloudflare Secrets, а не хранить в репозитории. ID получателей должны отличаться.
- `CUSTOMER_PASSWORD_RESET_URL` — HTTPS URL страницы сброса пароля.
- Один email transport: service binding `CUSTOMER_EMAIL_SERVICE`, HTTPS `CUSTOMER_EMAIL_ENDPOINT` или поддерживаемый runtime sender. Для HTTP provider при необходимости задаётся `CUSTOMER_EMAIL_API_TOKEN` как Secret. Для встроенной интеграции Resend используются endpoint `https://api.resend.com/emails`, подтверждённый sender в `CUSTOMER_EMAIL_FROM` и отдельный `CUSTOMER_EMAIL_API_TOKEN` для preview/production.

Preview получает собственные D1/R2 и тестовые provider credentials. Production secrets не копируются в preview автоматически. Если владелец явно одобрил общий Telegram bot/chats для acceptance, все три значения повторно вводятся как Preview Secrets; каждая первичная, повторная и recovery-отправка при `ENVIRONMENT=preview` начинается с `🧪 ТЕСТОВЫЙ ЗАКАЗ — НЕ ОБРАБАТЫВАТЬ`, чтобы тестовые заказы нельзя было принять за реальные.

Для Resend подтверждается почтовый поддомен `mail.nailmania.md` через выданные провайдером SPF/DKIM DNS records. Sender приложения — `Nail Mania <no-reply@mail.nailmania.md>`. API key создаётся только с правом `Sending access`, ограничивается доменом `mail.nailmania.md` и добавляется как encrypted Secret `CUSTOMER_EMAIL_API_TOKEN`; он не хранится в `wrangler.toml`, Git, логах или D1. Один transport обслуживает password-reset и подтверждения заказов. Preview и production используют разные API keys, чтобы их можно было отзывать независимо.

Pages Functions работают с R2 только через `PRODUCT_IMAGES`. S3 management credentials `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID` и `R2_BUCKET` не нужны в Pages runtime и не должны быть доступны приложению; они используются только из отдельного локального maintenance-окружения для guarded R2-утилит. После maintenance удалить их из Pages secrets.

## Readiness

После применения migrations и настройки deployment администратор с ролью `admin` проверяет:

```text
GET /api/admin/health/readiness
```

Endpoint возвращает только `ready` и boolean checks. Он не возвращает значения, длины, части или fingerprints секретов. `503` означает, что rollout продолжать нельзя; `manager` и клиентские роли доступа не имеют.

## Публичные JSON boundaries

Customer, promo и order mutations принимают только same-origin `application/json`. Streaming body ограничен до 16 KiB для customer, 32 KiB для promo validation и 64 KiB для заказа; превышение возвращает `413 REQUEST_BODY_TOO_LARGE` до Turnstile и бизнес-логики. Эти лимиты нельзя обходить отсутствующим или ложным `Content-Length`: фактически прочитанные bytes также ограничиваются.

## Роли и управление ценами

- `manager` обслуживает заказы, товары, категории, склад, возвраты и скидки каталога. Удаление товара мягкое: карточку можно восстановить.
- Только `admin` управляет промокодами и имеет доступ к статистике, audit log и readiness.
- Скидка каталога может охватывать отдельные товары, целые категории и целые бренды. Scope объединяется, пересекающиеся кампании не суммируются — действует наибольший процент.
- Кампания не изменяет базовые поля товара и не переводит импортный товар в ручной `source_type`; поэтому Google Sheet остаётся источником базовой цены, а effective price рассчитывается во время чтения и checkout.
- Новая или изменённая кампания повышает catalog revision. На запланированной границе начала/окончания edge-cache может показывать прежнюю цену не более текущего 60-секундного TTL; server quote читает D1 и остаётся авторитетным, а при несовпадении checkout требует повторного подтверждения.
- У промокода пустой scope означает всю корзину. Если выбраны товары, категории и/или бренды, они объединяются; brand/category scopes автоматически охватывают подходящие товары, добавленные позже.

Preview Access настроен на тестовый `*.pages.dev`, поэтому вход на весь Preview требует подтверждения email. Production storefront (`/`, каталог, checkout и customer account) должен оставаться публичным; Access policy для production разрешено привязывать только к административным назначениям `/admin*` и `/api/admin*`. Перед Production rollout проверить все destinations приложения Access и исключить wildcard/root production domain.

## Уведомления и инциденты

- Заказ сначала фиксируется в D1 вместе с резервом. Оба Telegram-уведомления и подтверждение покупателю по email выполняются после commit, поэтому сбой provider не отменяет заказ. Письмо отправляется, если покупатель указал email при оформлении.
- Для каждого Telegram-получателя ведётся независимая idempotent-попытка: сбой доставки одному человеку не вызывает повторное сообщение другому. Email-подтверждение также не дублируется при повторе заказа с тем же idempotency key.
- Каждая Telegram/email попытка и её итог записываются append-only в `notification_attempts` и `notification_attempt_statuses`. Записи защищены от `UPDATE`/`DELETE`; scheduled cleanup их не удаляет.
- Журнал не содержит customer payload, email address, phone, reset token, Telegram token/chat ID или provider response body. В нём остаются технические идентификаторы, безопасный failure code, HTTP status и request ID.
- Логи delivery структурированы и содержат request ID; произвольные provider errors и response bodies в них не попадают.
- При failed Telegram менеджер или администратор может повторить отправку в карточке заказа. API требует same-origin запрос и новый `Idempotency-Key`; повтор того же ключа не вызывает provider второй раз и не создаёт второй audit event.
- Незавершённая попытка получает пятиминутную lease. После неё append-only outcome фиксирует `NOTIFICATION_ATTEMPT_EXPIRED`; повтор с тем же ключом атомарно создаёт ровно одну recovery-попытку. Перед ручной отправкой API также закрывает старые `pending`, а кнопка становится доступна после lease. Это устраняет вечный `pending` после аварийного завершения Worker, но не устраняет внешнюю delivery ambiguity: если provider принял запрос и ответ потерялся, повтор теоретически может доставить дубликат.
- Password-reset token при неуспешной email delivery немедленно инвалидируется.

В карточке заказа внутренний комментарий менеджера редактируется отдельно от комментария к смене статуса. Сохранение использует optimistic revision; при `409 ORDER_COMMENT_CONFLICT` нужно перечитать заказ и вручную объединить изменения.
