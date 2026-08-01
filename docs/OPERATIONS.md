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
- `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID` — параметры Telegram delivery. Для приватности оба следует задавать через Cloudflare Secrets, а не хранить в репозитории.
- `CUSTOMER_PASSWORD_RESET_URL` — HTTPS URL страницы сброса пароля.
- Один email transport: service binding `CUSTOMER_EMAIL_SERVICE`, HTTPS `CUSTOMER_EMAIL_ENDPOINT` или поддерживаемый runtime sender. Для HTTP provider при необходимости задаётся `CUSTOMER_EMAIL_API_TOKEN` как Secret. Для встроенной интеграции Resend используются endpoint `https://api.resend.com/emails`, подтверждённый sender в `CUSTOMER_EMAIL_FROM` и отдельный `CUSTOMER_EMAIL_API_TOKEN` для preview/production.

Preview получает собственные D1/R2 и тестовые provider credentials. Production secrets не копируются в preview автоматически. Если владелец явно одобрил общий Telegram bot/chat для acceptance, оба значения повторно вводятся как Preview Secrets; каждая первичная, повторная и recovery-отправка при `ENVIRONMENT=preview` начинается с `🧪 ТЕСТОВЫЙ ЗАКАЗ — НЕ ОБРАБАТЫВАТЬ`, чтобы тестовые заказы нельзя было принять за реальные.

Для Resend подтверждается почтовый поддомен `mail.nailmania.md` через выданные провайдером SPF/DKIM DNS records. Sender приложения — `Nail Mania <no-reply@mail.nailmania.md>`. API key создаётся только с правом `Sending access`, ограничивается доменом `mail.nailmania.md` и добавляется как encrypted Secret `CUSTOMER_EMAIL_API_TOKEN`; он не хранится в `wrangler.toml`, Git, логах или D1. Preview и production используют разные API keys, чтобы их можно было отзывать независимо.

Pages Functions работают с R2 только через `PRODUCT_IMAGES`. S3 management credentials `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID` и `R2_BUCKET` не нужны в Pages runtime и не должны быть доступны приложению; они используются только из отдельного локального maintenance-окружения для guarded R2-утилит. После maintenance удалить их из Pages secrets.

## Readiness

После применения migrations и настройки deployment администратор с ролью `admin` проверяет:

```text
GET /api/admin/health/readiness
```

Endpoint возвращает только `ready` и boolean checks. Он не возвращает значения, длины, части или fingerprints секретов. `503` означает, что rollout продолжать нельзя; `manager` и клиентские роли доступа не имеют.

## Публичные JSON boundaries

Customer, promo и order mutations принимают только same-origin `application/json`. Streaming body ограничен до 16 KiB для customer, 32 KiB для promo validation и 64 KiB для заказа; превышение возвращает `413 REQUEST_BODY_TOO_LARGE` до Turnstile и бизнес-логики. Эти лимиты нельзя обходить отсутствующим или ложным `Content-Length`: фактически прочитанные bytes также ограничиваются.

## Уведомления и инциденты

- Заказ сначала фиксируется в D1 вместе с резервом. Telegram выполняется после commit, поэтому сбой provider не отменяет заказ.
- Каждая Telegram/email попытка и её итог записываются append-only в `notification_attempts` и `notification_attempt_statuses`. Записи защищены от `UPDATE`/`DELETE`; scheduled cleanup их не удаляет.
- Журнал не содержит customer payload, email address, phone, reset token, Telegram token/chat ID или provider response body. В нём остаются технические идентификаторы, безопасный failure code, HTTP status и request ID.
- Логи delivery структурированы и содержат request ID; произвольные provider errors и response bodies в них не попадают.
- При failed Telegram менеджер или администратор может повторить отправку в карточке заказа. API требует same-origin запрос и новый `Idempotency-Key`; повтор того же ключа не вызывает provider второй раз и не создаёт второй audit event.
- Незавершённая попытка получает пятиминутную lease. После неё append-only outcome фиксирует `NOTIFICATION_ATTEMPT_EXPIRED`; повтор с тем же ключом атомарно создаёт ровно одну recovery-попытку. Перед ручной отправкой API также закрывает старые `pending`, а кнопка становится доступна после lease. Это устраняет вечный `pending` после аварийного завершения Worker, но не устраняет внешнюю delivery ambiguity: если provider принял запрос и ответ потерялся, повтор теоретически может доставить дубликат.
- Password-reset token при неуспешной email delivery немедленно инвалидируется.

В карточке заказа внутренний комментарий менеджера редактируется отдельно от комментария к смене статуса. Сохранение использует optimistic revision; при `409 ORDER_COMMENT_CONFLICT` нужно перечитать заказ и вручную объединить изменения.
