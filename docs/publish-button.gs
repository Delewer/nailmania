/**
 * Disabled legacy Google Sheet publishing entrypoint.
 *
 * Keep this function name only so an old drawing/menu assignment fails safely.
 * Catalog publication must follow docs/RELEASE.md and must never call a Pages
 * deploy hook directly from Apps Script.
 */
function publishSite() {
  SpreadsheetApp.getUi().alert(
    'Publicarea directă este dezactivată. Folosiți procedura de release verificată.',
  );
}
