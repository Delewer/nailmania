# Deploying Nail Mania

The storefront is a **static website** built with Vite — no backend, no database.
All content (categories, products, prices, descriptions) lives in [`src/data.js`](src/data.js),
and photos are local files in [`public/images/`](public/images/README.md). You update the
shop by editing those, rebuilding, and re-uploading.

---

## 1. Add your images
Drop photos into `public/images/` using the filenames in
[`public/images/README.md`](public/images/README.md), e.g. `products/1.jpg`,
`categories/gellac.jpg`, `hero-1.jpg`. Any image you skip just shows the gradient
placeholder — so you can fill them in over time.

## 2. Edit content (optional)
Open `src/data.js` to change product names, prices, discounts (`old_price`),
brands, categories, or which badge (`new` / `sale` / `hit`) a product shows.

## 3. Build
```
npm install      # first time only
npm run build
```
This produces a **`dist/`** folder — the entire website, including your images and
the `.htaccess` routing file.

## 4. Publish to iphost.md (cPanel)

**File Manager (simplest):**
1. cPanel → **File Manager** → open **`public_html`**.
2. Remove the default placeholder page if present.
3. Zip the **contents of `dist/`**, upload the zip into `public_html`, then **Extract**.
   In File Manager settings enable *Show Hidden Files* so the **`.htaccess`** is included.
4. Open your domain. Enable cPanel **AutoSSL** for HTTPS.

**Or via Git/SSH** (iphost provides both):
```
git clone <your-repo> && cd nailmania
npm install && npm run build
# copy dist/* into public_html  (or point the domain docroot at dist/)
```

**To update the shop later:** edit data/images → `npm run build` → re-upload `dist/`.

---

## Routing
The site has client-side routes (`/product/123`, `/checkout`). The bundled
[`public/.htaccess`](public/.htaccess) rewrites unknown paths to `index.html` so those
URLs work on direct load / refresh. iphost's LiteSpeed server honors `.htaccess`.

## Custom domain
Point your domain's DNS at iphost (their nameservers / A record), add the domain in
cPanel, then enable AutoSSL. No code changes needed.

---

### Want to edit content without rebuilding?
That needs somewhere to store data online (a backend). Options, when you're ready:
- **In-browser admin** (localStorage) — quick, but edits only show on *your* device, so
  it's a demo, not a real shop admin.
- **Hosted backend** (e.g. Supabase free tier) — a real `/admin` page where edits go live
  for all customers without rebuilding. Best fit since iphost shared hosting can't run a
  Node backend. Ask and I'll wire it up.
