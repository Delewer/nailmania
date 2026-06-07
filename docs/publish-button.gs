/**
 * Кнопка «Опубликовать» для Google-таблицы Nail Mania.
 *
 * Установка (один раз):
 *  1. В таблице: Extensions → Apps Script (Расширения → Apps Script).
 *  2. Удалите пустой код, вставьте этот файл целиком.
 *  3. В строку DEPLOY_HOOK_URL вставьте Deploy Hook из Cloudflare Pages
 *     (Settings → Builds & deployments → Deploy hooks → Create → скопировать URL).
 *  4. Save. Обновите вкладку с таблицей — появится меню «🚀 Nail Mania».
 *
 * Использование: меняете товары → меню «🚀 Nail Mania» → «Опубликовать на сайте».
 * Сайт пересоберётся из таблицы и обновится за ~1–2 минуты.
 */

const DEPLOY_HOOK_URL = 'ВСТАВЬТЕ_СЮДА_CLOUDFLARE_DEPLOY_HOOK_URL';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🚀 Nail Mania')
    .addItem('Опубликовать на сайте', 'publishSite')
    .addToUi();
}

function publishSite() {
  const ui = SpreadsheetApp.getUi();
  if (!DEPLOY_HOOK_URL || DEPLOY_HOOK_URL.indexOf('http') !== 0) {
    ui.alert('Не настроено', 'Вставьте Deploy Hook URL в DEPLOY_HOOK_URL.', ui.ButtonSet.OK);
    return;
  }
  try {
    const res = UrlFetchApp.fetch(DEPLOY_HOOK_URL, { method: 'post', muteHttpExceptions: true });
    const code = res.getResponseCode();
    if (code >= 200 && code < 300) {
      ui.alert('✅ Публикация запущена', 'Сайт обновится через 1–2 минуты.', ui.ButtonSet.OK);
    } else {
      ui.alert('Ошибка публикации', 'Код ответа: ' + code + '\n' + res.getContentText(), ui.ButtonSet.OK);
    }
  } catch (e) {
    ui.alert('Ошибка', String(e), ui.ButtonSet.OK);
  }
}
