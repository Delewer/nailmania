# Nail Mania release runbook

Этот процесс разделяет проверку и публикацию. GitHub Actions не получает production-секреты и ничего не деплоит: CI только собирает код, применяет migrations к временной local D1 и запускает Wrangler `--dry-run`. Preview D1/Worker/Pages изменяются вручную авторизованным администратором после отдельного approval и до preview acceptance; production изменяется только после принятой preview evidence того же commit.

## Защитные правила

- Release выполняется только из чистого Git worktree и одного точного commit SHA.
- Никакой Apps Script/Cloudflare Deploy Hook не может публиковать production в обход этого runbook. Перед release удалить `DEPLOY_HOOK_URL`, отключить старый hook и убедиться, что после изменения Sheet не появился новый deployment.
- Preview и production используют разные D1, R2 и Scheduled Worker.
- Перед любым preview/production D1 mutation обязателен свежий export и Time Travel bookmark этой же базы и release SHA. Guard проверяет SQL и bookmark по SHA-256, размер, target и возраст не более четырёх часов.
- SQL backup содержит персональные данные клиентов. Он хранится в игнорируемом `tmp/backups`, затем переносится в зашифрованное приватное хранилище; его нельзя commit/upload в Actions artifact.
- Migrations только добавляются новыми файлами `NNNN_description.sql`. Уже применённые migrations не редактируются. `migrations/manifest.sha256` фиксирует canonical SHA-256 каждого SQL-файла; при добавлении migration в manifest добавляется новая строка, а существующие строки не меняются. `release:verify-config` останавливает release при любом расхождении имени, порядка или checksum.
- Каждая migration должна быть обратно совместима с уже опубликованным bundle на время rolling rollout; удаление старых колонок/таблиц выносится в более поздний release.
- Сначала schema, затем catalog import, Worker, Pages, smoke test. Production запускается только после успешного повторения той же последовательности в preview.
- Если строгая проверка Google Sheet нашла пустой/повторный SKU, release останавливается. Fallback на старый CSV запрещён.
- Перед первой миграцией промокодов `release:d1:migrate:*` выполняет read-only remote gate: если `0009_promotions.sql` ещё не применена, существующая `promo_redemptions` обязана быть пустой. Ненулевой результат останавливает migration до отдельного backfill.
- Генераторы catalog/admin SQL не имеют remote режима. Удалённые migrations, catalog import и выдача роли администратора выполняются только `release:d1:*`; каждый mutation в обеих средах требует точную release-ветку и полный `--expected-commit`, а manifest фиксирует commit, backup, migration-set checksum и checksums применённых артефактов без email/секретов.
- Обычный `npm run build` остаётся локальной/CI-компиляцией и может работать без Turnstile. Deploy разрешён только из `release:build:preview|production`: wrapper требует утверждённый `VITE_TURNSTILE_SITE_KEY` production-формата (публичные Cloudflare test keys не принимаются), clean worktree, точный SHA и проверяет наличие ключа в собранном `dist`. Это единственный разрешённый public `VITE_*` input; `VITE_CATALOG_ENDPOINT`, `VITE_CATEGORIES_ENDPOINT` и любые другие `VITE_*` из process environment или Vite `.env*` немедленно останавливают release, поэтому API остаётся same-origin. Manifest сохраняет SHA-256 fingerprint ключа и версию этого input-контракта. Site key публичный, но его значение не хранится в Git; `TURNSTILE_SECRET_KEY` всегда остаётся Cloudflare Secret.
- Pages публикуется только через `release:pages:preview|production`. Guard заново считает SHA-256 каждого байта Git-ignored `dist`, принимает manifest не старше 24 часов, требует clean worktree, полный HEAD, точные project/branch confirmations и D1 migrate/catalog manifests той же среды и commit, и лишь затем вызывает локальный Wrangler. Production дополнительно требует свежий `preview-acceptance-*.json`, неизменённый preview build manifest и исходные preview D1 manifests. Acceptance принимается только для точного origin `https://d1-preview-bootstrap.nailmania.pages.dev`. Preview и production bundle проверяются каждый своим manifest: их байты могут отличаться из-за разных публичных Turnstile site key, но исходный Git SHA обязан совпадать.
- Scheduled Worker собирается и публикуется только через `release:reservations:*`. Build wrapper выполняет Wrangler `--dry-run` в Git-ignored `tmp/releases`, фиксирует source, полный bundle и entrypoint SHA-256, commit, Worker, D1 и config digest. Deploy wrapper дополнительно требует свежий D1 migrate manifest той же среды/commit, повторно проверяет исходник, конфигурацию и сохранённые байты, branch/HEAD/target и точное текстовое подтверждение, после чего передаёт проверенный `reservations.js` Wrangler с `--no-bundle`; cron нельзя активировать против неаттестованной schema.
- Для production рекомендуется Workers Paid. Если выбран другой план, preview load/acceptance обязан доказать запас по CPU для PBKDF2 и по D1 queries на максимальном заказе/возврате; расхождение с актуальными Cloudflare limits останавливает rollout.

| Контур | D1 | R2 | Worker |
|---|---|---|---|
| local | `nailmania-local` | `nailmania-photos-local` | `nailmania-reservation-maintenance-local` |
| preview | `nailmania-preview` | `nailmania-product-images-preview` | `nailmania-reservation-maintenance-preview` |
| production | `nailmania-production` | `nailmania-photos` (`https://images.nailmania.md`) | `nailmania-reservation-maintenance-production` |

Analytics Engine is also isolated: `nailmania_product_events_preview` and `nailmania_product_events_production`. Before preview acceptance, configure `ANALYTICS_INDEX_SECRET`; for optional event metrics in the admin dashboard also configure non-secret `CLOUDFLARE_ACCOUNT_ID` and secret `ANALYTICS_READ_TOKEN`. Never place their values in Wrangler files, GitHub Actions or release artifacts. The exact event/report formulas are documented in `docs/STATISTICS.md`.

`wrangler.toml` не содержит секретов. До rollout вручную проверить bindings/vars/secrets в Cloudflare для обеих сред по `docs/OPERATIONS.md`; readiness endpoint проверяет только факт наличия, но не раскрывает значения. S3 management credentials не размещать в Pages runtime: приложению достаточно `PRODUCT_IMAGES`, а `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID` и `R2_BUCKET` должны существовать только в отдельном maintenance-окружении.

## Автоматические проверки

`.github/workflows/ci.yml` запускается для pull request и `main`. Он не обращается к удалённой D1 и проверяет:

- согласованность Cloudflare bindings, изоляцию окружений, порядок migrations и безопасность workflow;
- unit/integration tests;
- Vite/SEO и Pages Functions bundles;
- preview/production Scheduled Worker через `wrangler deploy --dry-run`;
- все migrations на новой временной local D1. Строгий catalog SQL/import проверяется отдельным release-readiness gate, чтобы известная ошибка бизнес-данных не блокировала обычные code pull requests.

`.github/workflows/publish.yml` — ручной release-readiness gate без секретов и без deploy. При запуске он требует публичный preview Turnstile site key как input, дополнительно загружает один canonical snapshot Google Sheet, строго проверяет его checksum/SKU, собирает каталог только из этих байтов и требует, чтобы generated catalog files уже были review/commit. Pages bundle строится guarded wrapper и проверяется на фактическое встраивание site key. Только после всех успешных gates на семь дней сохраняется единый artifact `release-readiness-<SHA>`: canonical CSV, все validation/build/import reports, generated SQL, Pages build manifest и точный `dist` для preview deploy, включая скрытые файлы. Частичный artifact при failed workflow не создаётся.

Старый FTP/Pages publish job удалён. Обязательные branch rules для `main`: pull request, успешный `CI verification`, запрет force-push/delete и хотя бы одно approval. Репозиторий рекомендуется сделать private; Git всё равно остаётся необходимым для идентификации и отката release SHA.

## Локальный preflight

Нужен Node.js 24.x, зависимости из lockfile и авторизованный Wrangler (`npx wrangler whoami`) только на машине администратора. Диапазон `engines.node` зафиксирован в `package.json`, а `engine-strict=true` в `.npmrc` заставляет `npm ci` завершиться ошибкой до preflight на другом major Node.

```powershell
npm ci
node scripts/verify-release-config.mjs
npm test
node scripts/validate-catalog-sheet.mjs
node scripts/build-catalog.mjs --validated-snapshot tmp/catalog-source.csv --validation-report tmp/catalog-validation.json
node scripts/import-catalog-d1.mjs
npx vite build
node scripts/build-seo.mjs
npx wrangler pages functions build functions --project-directory . --build-output-directory dist --outdir tmp/pages-functions --compatibility-date 2026-07-16
npx wrangler deploy --config wrangler.reservations.jsonc --env preview --dry-run --outdir tmp/worker-preview
npx wrangler deploy --config wrangler.reservations.jsonc --env production --dry-run --outdir tmp/worker-production
```

После запуска локального Pages runtime на loopback выполнить безопасный сквозной сценарий (он отказывается работать с любым не-loopback URL и без явного подтверждения):

```powershell
node scripts/acceptance-local.mjs --base-url http://127.0.0.1:8788 --admin-token nailmania-local-admin-only --confirm-local-mutations --report-file tmp/reports/local-acceptance.json
node scripts/load-check.mjs --base-url http://127.0.0.1:8788 --mode catalog --requests 120 --concurrency 12 --report-file tmp/reports/catalog-load.json
node scripts/browser-smoke.mjs --base-url http://127.0.0.1:8788 --report-file tmp/reports/browser-smoke.json
```

`--report-file` принимает только `.json` внутри игнорируемого `tmp/reports`, записывает файл атомарно только после успешного gate и не меняет JSON в stdout. Отчёт acceptance не содержит admin token или тестовые контактные данные покупателя.

`smoke:browser` находит установленный Chrome/Edge (либо использует `BROWSER_PATH`), проверяет главную, карточку товара, checkout, 404, вход покупателя и локальный вход администратора при ширине 1440 и 390 px. Он помещает ровно один доступный товар только в `localStorage`, блокирует все HTTP-методы кроме `GET`/`HEAD` до отправки в сеть и никогда не отправляет заказ или форму. PNG сохраняются в игнорируемом `tmp/browser-smoke`, а обезличенный JSON — в `tmp/reports`.

Generated `src/catalog.json` и `src/categories.json` должны быть review/commit до rollout. Затем повторить preflight из чистого checkout точного commit.

### R2 maintenance до release

`upload-r2.mjs` и `migrate-drive-r2.mjs` отказываются работать без точного preview/production bucket из `wrangler.toml`, его повторного подтверждения, чистого worktree и полного HEAD SHA. `rehost-images.mjs` строже: он разрешён только для production, только на branch `main`, только для exact bucket и canonical host из `catalog.config.json`; попытка указать preview завершается до сетевых запросов и R2 mutation. Эти команды не запускаются из `build`/CI; отсутствие credentials и частичная ошибка завершают команду ненулевым кодом. Public URL передаётся явно. Production URL обязан быть custom domain: `*.r2.dev` release guard не принимает из-за rate limiting.

Если перед release нужно перенести изображения, выполнить операцию как отдельное изменение до canonical catalog validation, затем review/commit получившиеся tracked файлы и повторить все gates. `src/catalog.json` является одним и тем же release artifact для preview и production: `rehost-images`/`migrate-drive-r2` запускаются только один раз для заранее выбранного canonical immutable image host, а не по разу для каждого окружения. Preview обязан проверить именно те URL, которые затем получит production. Production canonical host — `https://images.nailmania.md` на bucket `nailmania-photos`; известный legacy `r2.dev` origin переписывается на него без копирования объектов, с сохранением полного пути. Внешние URL после успешного rehost фиксируются в tracked URL map, чтобы следующая сборка из Google Sheet была воспроизводимой. До операции сверить фактический bucket, custom domain, object count и доступность объектов. Пример формы команды:

```powershell
$commit = git rev-parse HEAD
$env:R2_BUCKET = "nailmania-photos"
npm run rehost -- -- --environment production --confirm-bucket nailmania-photos --expected-commit $commit --public-base-url https://images.nailmania.md
```

Preview bucket для `rehost-images` не использовать: canonical catalog обязан ссылаться на один production image host, который затем проверяет preview storefront. После R2 maintenance нельзя продолжать rollout с прежним SHA, snapshot или backup. Preview/production release-build и guarded D1 catalog import отказываются принимать artifact, пока в нём остаётся хотя бы один внешний image host.

## Preview rollout

1. Перейти на release-ветку `d1-preview-bootstrap`, выбрать и записать полный SHA и проверить ветку/worktree:

   ```powershell
   $commit = git rev-parse HEAD
   if ((git branch --show-current) -ne "d1-preview-bootstrap") { throw "Preview release requires d1-preview-bootstrap" }
   if (git status --porcelain) { throw "Preview release requires a clean worktree" }
   ```
2. Запустить `Release readiness (no deploy)` для этого ref, передать утверждённый публичный site key preview widget в input `preview_turnstile_site_key` и дождаться зелёного результата. Скачать artifact `release-readiness-<SHA>` именно из этого успешного run и распаковать в корень чистого checkout, сохранив его структуру `tmp/...` и `dist/...` (через GitHub UI либо `gh run download <run-id> --name "release-readiness-$commit" --dir .`). Сверить SHA run/artifact с `$commit`; не заменять snapshot повторной загрузкой изменяемого Sheet. Artifact хранится семь дней, поэтому до истечения срока его нужно сохранить рядом с release evidence в утверждённом приватном хранилище.
3. Снять preview backup и bookmark, затем записать путь созданного SQL:

   ```powershell
   npm run release:d1:backup:preview
   $backup = "tmp/backups/preview-YYYY-MM-DDTHH-MM-SS-sssZ.sql"
   ```

4. Проверить ожидающие migrations и применить их с точным именем базы в confirmation guard:

   ```powershell
   npm run release:d1:status:preview
   npm run release:d1:migrate:preview -- --confirm nailmania-preview --expected-commit $commit --backup $backup
   $previewMigrationManifest = (Get-ChildItem tmp/releases/preview-migrate-*.json | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
   ```

5. Импортировать именно snapshot и validation report из скачанного release artifact:

   ```powershell
   npm run release:d1:catalog:preview -- --confirm nailmania-preview --expected-commit $commit --backup $backup --snapshot tmp/catalog-source.csv --validation-report tmp/catalog-validation.json
   $previewCatalogManifest = (Get-ChildItem tmp/releases/preview-catalog-*.json | Where-Object { $_.Name -notlike "*postconditions*" } | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
   ```

   Если staff-строки ещё не подготовлены в отдельной preview D1, выдать роль каждому заранее одобренному Access email с двойным подтверждением значения. Для продавца использовать `manager` (без промокодов, статистики, audit и readiness; точные promo code/id удаляются и из ответов заказов, но сумма скидки сохраняется), для владельца — `admin`:

   ```powershell
   $staffEmail = "approved-staff@example.com"
   npm run release:d1:admin:preview -- --confirm nailmania-preview --expected-commit $commit --backup $backup --email $staffEmail --confirm-email $staffEmail --role manager --confirm-role manager --name "Approved seller"
   ```

6. До первой удалённой публикации проверить Pages build manifest из artifact и собрать аттестованный Worker bundle. `dist` для preview не пересобирать: deploy использует точные байты, проверенные readiness workflow. Worker build выполняет локальный Wrangler `--dry-run`, сохраняет bundle и manifest; после человеческого approval deploy wrapper передаёт Wrangler именно сохранённый entrypoint с `--no-bundle`:

   ```powershell
   npm run release:reservations:build:preview -- --expected-commit $commit
   $previewWorkerManifest = (Get-ChildItem tmp/releases/preview-reservations-build-*.json | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
   $workerConfirmation = "DEPLOY RESERVATIONS nailmania-reservation-maintenance-preview nailmania-preview $commit"
   npm run release:reservations:preview -- --manifest $previewWorkerManifest --d1-migration-manifest $previewMigrationManifest --expected-commit $commit --confirm-worker nailmania-reservation-maintenance-preview --confirm-database nailmania-preview --confirm-deploy $workerConfirmation --dry-run
   npm run release:reservations:preview -- --manifest $previewWorkerManifest --d1-migration-manifest $previewMigrationManifest --expected-commit $commit --confirm-worker nailmania-reservation-maintenance-preview --confirm-database nailmania-preview --confirm-deploy $workerConfirmation
   ```

7. Опубликовать уже проверенный `dist` в preview branch Pages, прикрепив release SHA (между step 6 и этой командой не менять HEAD, worktree или build env). Сначала выполнить guard в `--dry-run`: он печатает план, но гарантированно не запускает Wrangler. Затем повторить без `--dry-run` только после отдельного approval:

   ```powershell
   $previewManifest = (Get-ChildItem tmp/releases/preview-pages-build-*.json | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
   $deployConfirmation = "DEPLOY PAGES nailmania d1-preview-bootstrap $commit"
   npm run release:pages:preview -- --manifest $previewManifest --d1-migration-manifest $previewMigrationManifest --d1-catalog-manifest $previewCatalogManifest --expected-commit $commit --confirm-project nailmania --confirm-branch d1-preview-bootstrap --confirm-deploy $deployConfirmation --dry-run
   npm run release:pages:preview -- --manifest $previewManifest --d1-migration-manifest $previewMigrationManifest --d1-catalog-manifest $previewCatalogManifest --expected-commit $commit --confirm-project nailmania --confirm-branch d1-preview-bootstrap --confirm-deploy $deployConfirmation
   ```

8. В Cloudflare проверить, что deployment использует preview D1/R2/Analytics Engine и не имеет production secrets. Выполнить acceptance: каталог/карточка/поиск, Access-вход обоих администраторов, сохранение товара/фото, тестовый заказ, повтор того же idempotency key, обработка изменившейся quote, бесплатная доставка от 2200 лей, промокод, резерв, отмена/освобождение, Telegram в закрытый preview-чат либо в явно одобренный общий чат с визуально проверенной первой строкой `🧪 ТЕСТОВЫЙ ЗАКАЗ — НЕ ОБРАБАТЫВАТЬ`, password-reset письмо через отдельный preview Resend key, readiness/статистика и статус cron. Удалить тестовые данные только штатными API/админскими действиями, сохранив audit trail. После полного прохождения записать sanitized evidence; loopback/private URL и HTTP команда не принимает:

   ```powershell
   $previewUrl = "https://d1-preview-bootstrap.nailmania.pages.dev"
   $acceptConfirmation = "ACCEPT PREVIEW nailmania d1-preview-bootstrap $commit"
   npm run release:pages:record-preview -- --manifest $previewManifest --d1-migration-manifest $previewMigrationManifest --d1-catalog-manifest $previewCatalogManifest --expected-commit $commit --preview-url $previewUrl --confirm-url $previewUrl --confirm-acceptance $acceptConfirmation --dry-run
   npm run release:pages:record-preview -- --manifest $previewManifest --d1-migration-manifest $previewMigrationManifest --d1-catalog-manifest $previewCatalogManifest --expected-commit $commit --preview-url $previewUrl --confirm-url $previewUrl --confirm-acceptance $acceptConfirmation
   $previewAcceptance = (Get-ChildItem tmp/releases/preview-acceptance-*.json | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
   ```

Любое расхождение завершает rollout; production не запускается.

## Production rollout

Назначить короткое окно изменений. Зафиксировать принятый в preview SHA и не перестраивать каталог из новых байтов между preview и production.

1. Перейти на чистый protected `main`, совпадающий с принятым SHA:

   ```powershell
   $commit = git rev-parse HEAD
   git status --short
   ```

2. Снять production backup. Команда сохраняет SQL, SHA-256 metadata и Time Travel bookmark в `tmp/backups`:

   ```powershell
   npm run release:d1:backup:production
   ```

3. Записать путь созданного `.sql` в `$backup`. Guard принимает только backup и Time Travel bookmark этой базы и commit, с верными checksums и возрастом не более четырёх часов:

   ```powershell
   $backup = "tmp/backups/production-YYYY-MM-DDTHH-MM-SS-sssZ.sql"
   npm run release:d1:status:production
   npm run release:d1:migrate:production -- --confirm nailmania-production --expected-commit $commit --backup $backup
   $productionMigrationManifest = (Get-ChildItem tmp/releases/production-migrate-*.json | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
   npm run release:d1:catalog:production -- --confirm nailmania-production --expected-commit $commit --backup $backup --snapshot tmp/catalog-source.csv --validation-report tmp/catalog-validation.json
   $productionCatalogManifest = (Get-ChildItem tmp/releases/production-catalog-*.json | Where-Object { $_.Name -notlike "*postconditions*" } | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
   ```

   Отдельно выдать роли только утверждённым production Access email (повторить для остальных сотрудников и выбрать `manager` либо `admin`):

   ```powershell
   $staffEmail = "approved-staff@example.com"
   npm run release:d1:admin:production -- --confirm nailmania-production --expected-commit $commit --backup $backup --email $staffEmail --confirm-email $staffEmail --role manager --confirm-role manager --name "Approved seller"
   ```

4. Собрать production Worker bundle guarded wrapper, затем выполнить deploy dry-run. После отдельного approval опубликовать Worker и проверенный Pages bundle. Production Pages guard потребует acceptance evidence, исходный build manifest и D1 manifests принятого preview; все артефакты должны относиться к тому же Git SHA. Production `dist` независимо сверяется с production manifest:

   ```powershell
   npm run release:reservations:build:production -- --expected-commit $commit
   $productionWorkerManifest = (Get-ChildItem tmp/releases/production-reservations-build-*.json | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
   $workerConfirmation = "DEPLOY RESERVATIONS nailmania-reservation-maintenance-production nailmania-production $commit"
   npm run release:reservations:production -- --manifest $productionWorkerManifest --d1-migration-manifest $productionMigrationManifest --expected-commit $commit --confirm-worker nailmania-reservation-maintenance-production --confirm-database nailmania-production --confirm-deploy $workerConfirmation --dry-run
   # Задать production VITE_TURNSTILE_SITE_KEY в окружении, не в файлах Git.
   npm run release:build:production -- --expected-commit $commit
   npm run release:reservations:production -- --manifest $productionWorkerManifest --d1-migration-manifest $productionMigrationManifest --expected-commit $commit --confirm-worker nailmania-reservation-maintenance-production --confirm-database nailmania-production --confirm-deploy $workerConfirmation
   $productionManifest = (Get-ChildItem tmp/releases/production-pages-build-*.json | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
   $previewManifest = (Get-ChildItem tmp/releases/preview-pages-build-*.json | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
   $previewMigrationManifest = (Get-ChildItem tmp/releases/preview-migrate-*.json | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
   $previewCatalogManifest = (Get-ChildItem tmp/releases/preview-catalog-*.json | Where-Object { $_.Name -notlike "*postconditions*" } | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
   $previewAcceptance = (Get-ChildItem tmp/releases/preview-acceptance-*.json | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
   $deployConfirmation = "DEPLOY PAGES nailmania main $commit"
   npm run release:pages:production -- --manifest $productionManifest --d1-migration-manifest $productionMigrationManifest --d1-catalog-manifest $productionCatalogManifest --preview-manifest $previewManifest --preview-d1-migration-manifest $previewMigrationManifest --preview-d1-catalog-manifest $previewCatalogManifest --preview-acceptance $previewAcceptance --expected-commit $commit --confirm-project nailmania --confirm-branch main --confirm-deploy $deployConfirmation --dry-run
   npm run release:pages:production -- --manifest $productionManifest --d1-migration-manifest $productionMigrationManifest --d1-catalog-manifest $productionCatalogManifest --preview-manifest $previewManifest --preview-d1-migration-manifest $previewMigrationManifest --preview-d1-catalog-manifest $previewCatalogManifest --preview-acceptance $previewAcceptance --expected-commit $commit --confirm-project nailmania --confirm-branch main --confirm-deploy $deployConfirmation
   ```

5. Проверить bindings/secrets deployment и выполнить короткий production smoke: публичный GET каталога, один контролируемый заказ, резерв, отмена, Access обоих администраторов, загрузка/удаление тестового R2-изображения, Worker logs. При успехе закрыть окно и сохранить release manifest из `tmp/releases` рядом с зашифрованным backup.

Короткие npm-команды, обходившие guard (`db:migrate:*`, remote `catalog:seed:*`, remote `db:seed-admin:*` и прямой `wrangler deploy` для облачных окружений), запрещены. Для D1 используются только `release:d1:*` wrappers с аргументами подтверждения после `--`; вспомогательные catalog/admin scripts лишь генерируют SQL. Worker публикуется только через `release:reservations:*` из сохранённого attested bundle, Pages — только через `release:pages:*` с D1 evidence после dry-run и approval.

## Rollback и восстановление

Сначала остановить новые административные изменения и определить слой сбоя.

- Только Pages-код: в Cloudflare Pages выбрать предыдущий успешный deployment и выполнить rollback. D1 не трогать.
- Только Scheduled Worker: получить предыдущую version из `npx wrangler deployments list --name nailmania-reservation-maintenance-production`, затем после approval выполнить `npx wrangler rollback <version-id> --name nailmania-reservation-maintenance-production`.
- Данные/schema: предпочтителен совместимый forward-fix новой migration. Time Travel restore откатывает всю базу и удаляет записи после bookmark, поэтому применяется только как incident operation с подтверждённым окном потери данных.

Перед Time Travel restore сначала экспортировать текущее аварийное состояние в новый файл. Затем извлечь bookmark из соответствующего `tmp/backups/*.bookmark.json`, перепроверить базу и время и только после двух подтверждений выполнить:

```powershell
npx wrangler d1 time-travel restore nailmania-production --bookmark <bookmark> --config wrangler.toml --env production
```

После восстановления откатить Pages/Worker к совместимому SHA, повторить smoke test и отдельно перенести допустимые заказы, созданные после bookmark, из аварийного export. Никогда не импортировать production SQL в preview без очистки персональных данных.
