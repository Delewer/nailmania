# Кнопка «Опубликовать» (без расписания)

Каталог «впекается» в сайт при сборке, поэтому правки в Google-таблице попадают
на сайт после пересборки. Чтобы клиент управлял этим сам, в таблице есть кнопка
**🚀 Nail Mania → Опубликовать на сайте** — она запускает пересборку по требованию.
Никаких автоматических сборок «каждые 2 часа» не нужно.

Как клиент работает каждый день:
> меняет товары в таблице → меню **🚀 Nail Mania → Опубликовать на сайте** →
> через ~1–2 минуты сайт обновлён.

---

## Разовая настройка (для разработчика)

### 1. Подключить репозиторий к Cloudflare Pages
Cloudflare → **Workers & Pages → Create → Pages → Connect to Git** → выбрать репозиторий.
Настройки сборки:
- **Build command:** `npm run catalog && npm run build`
- **Build output directory:** `dist`
- **Environment variables:**
  - `CATALOG_SHEET_URL` = ссылка на таблицу (Publish to web → CSV)
  - `TELEGRAM_BOT_TOKEN` = токен бота
  - `TELEGRAM_CHAT_ID` = ваш chat_id (см. docs/ORDERS.md)
  - `NODE_VERSION` = `20`

Функция заказов (`functions/api/order.js`) подхватится автоматически.

### 2. Создать Deploy Hook
В проекте Pages: **Settings → Builds & deployments → Deploy hooks → Create deploy hook**
(ветка — `main`/`production`). Скопировать получившийся URL — это «кнопка публикации».

### 3. Вставить кнопку в таблицу
1. В Google-таблице: **Extensions → Apps Script**.
2. Вставить код из [`publish-button.gs`](publish-button.gs).
3. В `DEPLOY_HOOK_URL` вставить URL из шага 2. **Save**.
4. Обновить вкладку таблицы — появится меню **🚀 Nail Mania**.

### 4. Проверить
Меню **🚀 Nail Mania → Опубликовать на сайте** → дождаться сборки (видно в Cloudflare
Pages → Deployments) → проверить сайт.

---

## Почему так
- **Бесплатно:** Cloudflare Pages free (до 500 сборок/мес — публикаций по кнопке столько не бывает).
- **Без лишних сборок:** собираем только когда нажали кнопку.
- **Просто для клиента:** одна кнопка прямо в таблице, куда он и так вносит товары.

> Альтернатива без Cloudflare: запускать пересборку вручную через GitHub →
> вкладка **Actions → Publish shop → Run workflow** (см. `.github/workflows/publish.yml`).
