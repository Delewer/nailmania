# Publishing catalog changes

Прежняя схема «кнопка в Google Sheet → Cloudflare Deploy Hook» выведена из нового release-процесса. Deploy Hook может перестроить Pages без строгой SKU-проверки, D1 backup, migrations, catalog import и preview acceptance. Поэтому перед rollout нужно удалить `DEPLOY_HOOK_URL` из Apps Script и отключить соответствующий Cloudflare Pages Deploy Hook; удаления reference-файла из Git недостаточно. По той же причине удалён legacy FTP deployment из GitHub Actions.

Google Sheet остаётся источником каталога, но публикация выполняется по контролируемой процедуре из [RELEASE.md](RELEASE.md):

1. скачать и строго проверить один canonical CSV snapshot;
2. собрать каталог и D1 SQL только из проверенных байтов;
3. пройти local D1 smoke и preview acceptance;
4. снять production backup/Time Travel bookmark;
5. применить migrations/import и опубликовать ровно принятый Git commit.

`docs/publish-button.gs` сохранён как безопасный tombstone для старой кнопки: он только показывает сообщение и не выполняет сетевых запросов. Release verifier запрещает возвращать в него `UrlFetchApp.fetch`, Script Properties или deploy-hook URL. Read-only аудит 18 июля 2026 года обнаружил повторные production deployments одного старого SHA, совпадающие по времени с изменениями Sheet; до подтверждённого удаления внешнего hook из реально привязанного Apps Script/Pages rollout запрещён. Все Cloudflare/Telegram/R2 credentials хранятся вне репозитория; проверочные GitHub workflows не запрашивают секреты и не выполняют deploy.
