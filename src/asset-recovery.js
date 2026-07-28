const assetReloadKey = 'nm_asset_reload_count';
const mountReloadKey = 'nm_mount_reload_count';
const maxReloads = 3;

function getCount(key) {
  try {
    return Number(sessionStorage.getItem(key) || 0);
  } catch {
    return 0;
  }
}

function setCount(key, value) {
  try { sessionStorage.setItem(key, String(value)); } catch {}
}

function retryWithFreshHtml(reason, key) {
  const count = getCount(key);
  if (count >= maxReloads) return;
  setCount(key, count + 1);
  const url = new URL(window.location.href);
  url.searchParams.set('nm_reload', Date.now().toString());
  url.searchParams.set('nm_reason', reason || 'refresh');
  window.location.replace(url.toString());
}

function hasStaticFallback() {
  const root = document.getElementById('root');
  return Boolean(root?.querySelector('.seo-static'));
}

function checkMount() {
  if (!window.__NM_APP_READY__ && hasStaticFallback()) {
    retryWithFreshHtml('mount', mountReloadKey);
  }
}

function scheduleMountChecks() {
  window.setTimeout(checkMount, 7000);
  window.setTimeout(checkMount, 14000);
}

window.__NM_MARK_READY__ = function markReady() {
  window.__NM_APP_READY__ = true;
  try {
    sessionStorage.removeItem(assetReloadKey);
    sessionStorage.removeItem(mountReloadKey);
  } catch {}
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has('nm_reload') || url.searchParams.has('nm_reason')) {
      url.searchParams.delete('nm_reload');
      url.searchParams.delete('nm_reason');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  } catch {}
};

window.addEventListener('error', (event) => {
  const target = event?.target;
  const url = target && (target.src || target.href);
  const tag = target?.tagName;
  if (url && /\/assets\//.test(url) && /^(SCRIPT|LINK)$/i.test(tag || '')) {
    retryWithFreshHtml('asset', assetReloadKey);
  }
}, true);

window.addEventListener('unhandledrejection', (event) => {
  const reason = String(event?.reason?.message || event?.reason || '');
  if (/Failed to fetch dynamically imported module|Importing a module script failed|Failed to load module script|Loading chunk/i.test(reason)) {
    retryWithFreshHtml('module', assetReloadKey);
  }
});

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', scheduleMountChecks, { once: true });
} else {
  scheduleMountChecks();
}
