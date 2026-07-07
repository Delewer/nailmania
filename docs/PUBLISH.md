# Publishing products from Google Sheets

The default product spreadsheet is configured in `catalog.config.json`.
Cloudflare production uses `CATALOG_SHEET_URL` when `CATALOG_USE_SHEET=1`. The
current sheet is public and can be read through Google's CSV endpoint; it does
not need to be separately published as CSV.

Cloudflare Pages rebuilds the storefront when its deploy hook receives a POST
request. The spreadsheet button does not read or publish products by itself: it
only calls that hook through a container-bound Google Apps Script.

## Configure the spreadsheet button

1. In Cloudflare Pages, open **Settings -> Builds & deployments -> Deploy hooks**
   and create or copy the hook for the `main` branch.
2. In the product spreadsheet, open **Extensions -> Apps Script** and paste the
   contents of `docs/publish-button.gs`.
3. In Apps Script, open **Project Settings -> Script properties** and add
   `DEPLOY_HOOK_URL` with the Cloudflare hook URL.
4. Save the script, run `publishSite` once from Apps Script, and authorize it.
5. Reload the spreadsheet. Use **Site -> Publish website**. If a drawing is used
   as a button, assign the script name `publishSite` to it.

The script checks the HTTP status and shows an error dialog when the hook is
missing, expired, or rejected. This avoids a silent no-op.

## Local verification

```powershell
npm run catalog
npm run build
```

The catalog build falls back to `nailmania-sheet.csv` only when the configured
Google Sheet cannot be downloaded or does not contain a recognizable catalog.
