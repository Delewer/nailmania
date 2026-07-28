const DEFAULT_SITE = 'https://nailmania.md';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
export const escapeXml = escapeHtml;
export const cleanSeoText = (value, max = 160) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

export function siteOrigin(env) {
  const configured = String(env?.SITE_URL || '').trim();
  if (!configured) return DEFAULT_SITE;
  try { return new URL(configured).origin; }
  catch { return DEFAULT_SITE; }
}

export const absoluteUrl = (value, site = DEFAULT_SITE) => {
  const raw = String(value || '').trim();
  if (!raw) return `${site}/images/logo-high.png`;
  try { return new URL(raw, `${site}/`).toString(); }
  catch { return `${site}/images/logo-high.png`; }
};

export function seoHead({
  title,
  description,
  canonical,
  image,
  type = 'website',
  robots = 'index,follow,max-image-preview:large',
  schema = {},
}) {
  return `<!-- SEO:START -->
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}"/>
<meta name="robots" content="${escapeHtml(robots)}"/>
<link rel="canonical" href="${escapeHtml(canonical)}"/>
<meta property="og:type" content="${escapeHtml(type)}"/>
<meta property="og:site_name" content="Nail Mania"/>
<meta property="og:locale" content="ro_MD"/>
<meta property="og:title" content="${escapeHtml(title)}"/>
<meta property="og:description" content="${escapeHtml(description)}"/>
<meta property="og:url" content="${escapeHtml(canonical)}"/>
<meta property="og:image" content="${escapeHtml(image)}"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${escapeHtml(title)}"/>
<meta name="twitter:description" content="${escapeHtml(description)}"/>
<meta name="twitter:image" content="${escapeHtml(image)}"/>
<script id="seo-jsonld" type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script>
<!-- SEO:END -->`;
}

export async function loadSpaShell(context) {
  if (!context.env?.ASSETS || typeof context.env.ASSETS.fetch !== 'function') {
    throw Object.assign(new Error('Pages ASSETS binding is not configured'), {
      code: 'ASSETS_NOT_CONFIGURED',
      status: 503,
    });
  }
  const shellUrl = new URL('/spa-shell', context.request.url);
  const response = await context.env.ASSETS.fetch(new Request(shellUrl, {
    headers: { accept: 'text/html' },
  }));
  if (!response.ok) {
    throw Object.assign(new Error('SPA shell asset is unavailable'), {
      code: 'SPA_SHELL_UNAVAILABLE',
      status: 503,
    });
  }
  return response.text();
}

export function renderSeoHtml(shell, meta, body, status = 200) {
  const withHead = shell.replace(/<!-- SEO:START -->[\s\S]*?<!-- SEO:END -->/, seoHead(meta));
  const root = '<div id="root"></div>';
  if (!withHead.includes(root)) {
    throw Object.assign(new Error('SPA shell has no empty root mount'), {
      code: 'INVALID_SPA_SHELL',
      status: 503,
    });
  }
  const html = withHead.replace(
    root,
    `<div id="root"><main class="seo-static" style="max-width:1180px;margin:40px auto;padding:20px;font-family:Arial,sans-serif;color:#2d212a">${body}</main></div>`,
  );
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

export const html = escapeHtml;
