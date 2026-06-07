# Images

Drop your real photos here. Anything missing automatically shows the colored
gradient placeholder instead — so you can add images gradually, nothing breaks.

All files are plain **`.jpg`**. Square images (1:1) look best for products;
roughly 800×800px is plenty. Category images can be any ratio (they're cropped to fit).

## Categories  → `images/categories/`
One file per category, named by its id:

```
gellac.jpg        baze.jpg          topuri.jpg        alungire.jpg
solutii.jpg       bituri.jpg        instrumente.jpg   lichide.jpg
sterilizare.jpg   epilare.jpg       pedichiura.jpg    tehnica.jpg
accesuare.jpg     sprancene.jpg     gene.jpg          ingrijire.jpg
materiale.jpg     design.jpg        slidiz.jpg
```

## Products  → `images/products/`
Named by the product **SKU** (the `cod`/SKU column from the price list, e.g.
`T1338`, `3055`). The SKU shows on each product page under "Cod" and is the stable
key — it keeps matching even after the catalog is rebuilt. Optional extra gallery
shots use `-2`, `-3`, `-4`:

```
T1338.jpg      ← main photo for SKU T1338
T1338-2.jpg    ← optional 2nd gallery image
T1338-3.jpg    T1338-4.jpg
3055.jpg  T0001.jpg  …
```

List every SKU with:
`node -e "require('./src/catalog.json').forEach(p=>console.log(p.code))"`

### Supplier image URLs (no manual download)
If your distributor gives you a photo link per product, add an **`Image`** column
to the spreadsheet (header `Image`/`Photo`/`Poza`/`URL`), then re-run
`npm run catalog` — the site will use those URLs directly, no files needed here.

## Hero + About  → `images/`
```
hero-1.jpg    large dark "Dark gel collection" card
hero-2.jpg    "−30% / Reduceri" card
about.jpg     photo beside the delivery/about section
```

> After adding images, rebuild (`npm run build`) and re-upload `dist/`.
