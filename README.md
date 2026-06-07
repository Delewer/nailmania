# Nail Mania — Storefront

A bilingual (RO/RU), fully responsive nail-supply storefront for **Nail Mania** (Ungheni, Moldova). Built from the Claude Design handoff — vev.md's page structure rendered in Nail Mania's soft dusty-mauve + blush palette.

Implemented as a **Vite + React 18** app. The in-browser Babel prototype from the design bundle was ported to real ES modules; all CSS is preserved verbatim.

## Run

```bash
npm install
npm run dev      # dev server (http://localhost:5173)
npm run build    # production build to dist/
npm run preview  # preview the production build
```

## Structure

```
index.html              app shell + Google Fonts (Manrope / Playfair Display)
src/
  main.jsx              React entry, imports global CSS
  App.jsx               page composition
  data.js               categories, products, brands, RO/RU i18n strings
  shop.jsx              ShopProvider context (cart/favs/lang/drawers), Icon, Placeholder
  styles.css            design tokens + base styles
  components.css        component styles
  components/
    Header.jsx          top bar, logo, live search, catalog button, action icons
    Hero.jsx            hero, colored category pills, delivery banner, category tiles
    Products.jsx        product card + paginated product sections
    Content.jsx         brands wall, about/delivery, social row, footer
    Menus.jsx           catalog mega-menu, cart/favorites/mobile drawers, toast
```

## Features

- **Top bar → search header**: free-delivery promo, hours, RO/RU switch; black serif logo, mauve Catalog button, live search with results dropdown, favorites/cart with count badges.
- **Hero + side promo cards → 3 colored category pills → peach free-delivery banner.**
- **17-category tile grid → Bestsellers / New / Sale** product grids with badges, lei prices, favorite hearts, add-to-cart, pagination.
- **28-brand wall → delivery/about block → social row → dark footer.**
- **Interactive & bilingual**: catalog mega-menu, live search, slide-out cart (qty, totals, checkout), favorites drawer, mobile hamburger menu, RO/RU toggle that translates everything, "added to cart" toast. Cart / favorites / language persist in `localStorage`. Responsive down to mobile.

## Content & images

- All categories, products, prices and descriptions live in [`src/data.js`](src/data.js).
- Photos are local files in [`public/images/`](public/images/README.md) — drop in `.jpg`s
  named per the guide there (`products/1.jpg`, `categories/gellac.jpg`, …). Any image you
  haven't added yet falls back to a gradient placeholder, so nothing ever looks broken.
- Brand logos render as styled text; drop in real logo files to replace.

See [`DEPLOY.md`](DEPLOY.md) for building and publishing to iphost.md.
