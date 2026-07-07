/**
 * Container-bound Google Apps Script for the product spreadsheet.
 *
 * One-time setup:
 * 1. In Apps Script, open Project Settings -> Script properties.
 * 2. Add DEPLOY_HOOK_URL with the Cloudflare Pages deploy-hook URL.
 * 3. Reload the spreadsheet and use Site -> Publish website.
 *
 * If the sheet contains a drawing used as a button, assign the function name
 * publishSite to that drawing.
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Site')
    .addItem('Publish website', 'publishSite')
    .addToUi();
}

function publishSite() {
  const ui = SpreadsheetApp.getUi();
  const hookUrl = PropertiesService.getScriptProperties().getProperty('DEPLOY_HOOK_URL');

  if (!hookUrl) {
    ui.alert('Publishing is not configured: DEPLOY_HOOK_URL is missing in Script properties.');
    return;
  }

  try {
    const response = UrlFetchApp.fetch(hookUrl, {
      method: 'post',
      muteHttpExceptions: true,
    });
    const status = response.getResponseCode();

    if (status < 200 || status >= 300) {
      throw new Error('deploy hook returned HTTP ' + status);
    }

    ui.alert('Publishing started. The website will update in 1–2 minutes.');
  } catch (error) {
    ui.alert('Publishing failed: ' + error.message);
  }
}
