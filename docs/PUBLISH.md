# Как обновляется магазин (товары и фото)

Всё — и товары, и фото — лежит в **одной** Google-таблице (один файл
`nailmania-sheet.csv` с колонкой **Foto**). Клиент правит таблицу и жмёт
«Опубликовать» → Cloudflare пересобирает сайт за 1–2 минуты.

```
Google-таблица  ──(Опубликовать)──▶  Cloudflare Pages
  товары + Foto                        npm run build:
                                         1) catalog  — тянет таблицу → src/catalog.json
                                         2) rehost   — все внешние фото-URL → R2
                                         3) vite     — собирает сайт → dist
```

Фото никогда не зависят от чужих сайтов: что бы клиент ни вставил в колонку **Foto**,
сборка скачивает картинку и кладёт её на наш R2. Если URL не открылся — он
остаётся как есть, а сайт всё равно собирается (в логе будет предупреждение).

---

## 1. Настройка Cloudflare Pages (один раз)

**Pages → Create → Connect to Git → репозиторий `Delewer/nailmania`.**

- **Build command:** `npm run build`  (он сам прогоняет catalog → rehost → vite)
- **Output directory:** `dist`
- **Framework preset:** None (или Vite)

**Settings → Environment variables** (Production *и* Preview):

| Переменная | Значение |
|---|---|
| `CATALOG_USE_SHEET` | `1` |
| `CATALOG_SHEET_URL` | ссылка таблицы: *Файл → Поделиться → Опубликовать в интернете → нужная вкладка → CSV* |
| `R2_ACCOUNT_ID` | из R2 (нужно для авто-перехостинга фото) |
| `R2_ACCESS_KEY_ID` | R2 API token |
| `R2_SECRET_ACCESS_KEY` | R2 API token |
| `R2_BUCKET` | имя бакета |
| `TELEGRAM_BOT_TOKEN` | для приёма заказов (`functions/api/order.js`) |
| `TELEGRAM_CHAT_ID` | куда слать заказы |

> Без `CATALOG_USE_SHEET=1` сборка берёт локальный `nailmania-sheet.csv` (таблица игнорируется).
> Без R2-ключей фото не перехостятся (внешние URL уедут на сайт как есть).

**Деплой-хук** (кнопка «Опубликовать» дёргает именно его):
Settings → **Builds & deployments → Deploy hooks → Create** → имя `publish`, ветка `main`
→ скопировать URL вида `https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/...`.

---

## 2. Google-таблица (для клиента)

Один импорт `nailmania-sheet.csv` → в таблице появляются все колонки
(порядок неважен, заголовки распознаются по названию):

`Brand` · `SKU` · `Category` · `Title` · `Text` · `Quantity` · `Price` · `Price Old` · `Sale` · `New` · `Promo` · **`Foto`**

- **Добавить товар** — новая строка, заполнить поля. В **Foto** вставить ссылку на картинку.
- **Убрать товар** — удалить строку.
- **Поменять фото/цену** — отредактировать ячейку.
- **Опубликовать** — меню **Сайт → Опубликовать** (см. ниже).

`SKU` — уникальный код товара (по нему сопоставляются заказы). Не меняй у существующих.
Несколько фото для одного товара — через пробел в ячейке **Foto** (галерея).

---

## 3. Кнопка «Опубликовать» (Apps Script, один раз)

В таблице: **Расширения → Apps Script**, вставить код, подставить URL деплой-хука, сохранить.
Обновить страницу таблицы — появится меню **Сайт**.

```javascript
const DEPLOY_HOOK_URL = 'ВСТАВЬ_СЮДА_URL_ДЕПЛОЙ_ХУКА';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Сайт')
    .addItem('Опубликовать', 'publishSite')
    .addToUi();
}

function publishSite() {
  const ui = SpreadsheetApp.getUi();
  try {
    UrlFetchApp.fetch(DEPLOY_HOOK_URL, { method: 'post', muteHttpExceptions: true });
    ui.alert('Публикация запущена. Сайт обновится через 1–2 минуты.');
  } catch (e) {
    ui.alert('Ошибка публикации: ' + e);
  }
}
```

---

## Важно

- При `CATALOG_USE_SHEET=1` **таблица — источник правды**. Если строки товара нет в таблице —
  его не будет и на сайте. Держи таблицу полной.
- Если таблица недоступна/битая в момент сборки — сборка не падает, а берёт последний
  закоммиченный `nailmania-sheet.csv` (предохранитель от пустого сайта).
- Отдельного файла фото больше нет — всё в колонке **Foto**. Не пересобирай
  `nailmania-sheet.csv` старым `scripts/import-list.mjs`: он не знает про фото и затрёт Foto.

## Локально / вручную

```bash
npm run build      # catalog → rehost → vite (то же, что делает Cloudflare)
npm run catalog    # только пересобрать src/catalog.json из источника
npm run rehost     # только перенести внешние фото-URL из каталога на R2
```
