import {
  CATALOG_ENDPOINT,
  loadStorefrontCatalog,
} from "./catalog-api.js";
import { decorateCategory, productGallery } from "./data.js";

export async function loadFreshStorefrontProducts() {
  const snapshot = await loadStorefrontCatalog({
    catalogEndpoint: (import.meta.env && import.meta.env.VITE_CATALOG_ENDPOINT) || CATALOG_ENDPOINT,
  });
  const categories = snapshot.categories.map(decorateCategory);
  const categoryMap = Object.fromEntries(categories.map((category) => [category.id, category]));
  return snapshot.products.map((product) => {
    const category = categoryMap[product.cat];
    return {
      ...product,
      ro: product.name,
      ru: product.nameRu || product.name,
      badge: product.old > product.price ? "sale" : "",
      g: category?.g || ["#e7d6dd", "#f5ebef"],
      icon: category?.icon || "bottle",
      img: productGallery(product)[0],
    };
  });
}
