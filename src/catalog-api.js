export const PRODUCTS_ENDPOINT = "/api/products?limit=5000";
export const CATEGORIES_ENDPOINT = "/api/categories";

export class CatalogApiError extends Error {
  constructor(code, message, { endpoint = "", status = 0, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "CatalogApiError";
    this.code = code;
    this.endpoint = endpoint;
    this.status = status;
  }
}

const invalidResponse = (endpoint, message) => new CatalogApiError(
  "CATALOG_API_INVALID_RESPONSE",
  message,
  { endpoint },
);

const requireObject = (value, endpoint, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidResponse(endpoint, `${label} must be an object`);
  }
  return value;
};

const requireString = (value, endpoint, label) => {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidResponse(endpoint, `${label} must be a non-empty string`);
  }
  return value.trim();
};

const requireFiniteNumber = (value, endpoint, label, { min = -Infinity } = {}) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    throw invalidResponse(endpoint, `${label} must be a finite number${Number.isFinite(min) ? ` >= ${min}` : ""}`);
  }
  return value;
};

async function requestCollection(fetchImpl, endpoint, label) {
  let response;
  try {
    response = await fetchImpl(endpoint, { headers: { accept: "application/json" } });
  } catch (cause) {
    throw new CatalogApiError(
      "CATALOG_API_UNAVAILABLE",
      `${label} API is unavailable`,
      { endpoint, cause },
    );
  }

  if (!response || typeof response.ok !== "boolean") {
    throw invalidResponse(endpoint, `${label} API did not return a Response`);
  }
  if (!response.ok) {
    throw new CatalogApiError(
      "CATALOG_API_UNAVAILABLE",
      `${label} API returned ${response.status}`,
      { endpoint, status: response.status },
    );
  }
  if (!(response.headers?.get("content-type") || "").toLowerCase().includes("application/json")) {
    throw invalidResponse(endpoint, `${label} API did not return JSON`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new CatalogApiError(
      "CATALOG_API_INVALID_RESPONSE",
      `${label} API returned malformed JSON`,
      { endpoint, cause },
    );
  }
  requireObject(payload, endpoint, `${label} payload`);
  if (payload.ok !== true || !Array.isArray(payload.items)) {
    throw invalidResponse(endpoint, `${label} payload must contain ok=true and an items array`);
  }
  if (!payload.items.length) {
    throw invalidResponse(endpoint, `${label} API returned an empty collection`);
  }
  return payload.items;
}

function validateCategories(items, endpoint) {
  const ids = new Set();
  const slugs = new Set();
  return items.map((raw, index) => {
    const item = requireObject(raw, endpoint, `Category ${index}`);
    const id = requireString(item.id, endpoint, `Category ${index}.id`);
    const slug = requireString(item.slug, endpoint, `Category ${index}.slug`);
    requireString(item.name_ro, endpoint, `Category ${index}.name_ro`);
    if (item.name_ru != null && typeof item.name_ru !== "string") {
      throw invalidResponse(endpoint, `Category ${index}.name_ru must be a string`);
    }
    for (const field of ["seo_title_ro", "seo_title_ru", "seo_description_ro", "seo_description_ru"]) {
      if (item[field] != null && typeof item[field] !== "string") {
        throw invalidResponse(endpoint, `Category ${index}.${field} must be a string`);
      }
    }
    requireFiniteNumber(item.sort_order, endpoint, `Category ${index}.sort_order`);
    requireFiniteNumber(item.product_count, endpoint, `Category ${index}.product_count`, { min: 0 });
    if (ids.has(id)) throw invalidResponse(endpoint, `Duplicate category id: ${id}`);
    if (slugs.has(slug)) throw invalidResponse(endpoint, `Duplicate category slug: ${slug}`);
    ids.add(id);
    slugs.add(slug);
    return item;
  });
}

function validateProducts(items, endpoint, categoryIds) {
  const keys = new Set();
  return items.map((raw, index) => {
    const item = requireObject(raw, endpoint, `Product ${index}`);
    const key = requireString(item.key, endpoint, `Product ${index}.key`);
    const categoryId = requireString(item.cat, endpoint, `Product ${index}.cat`);
    requireString(item.name, endpoint, `Product ${index}.name`);
    requireString(item.brand, endpoint, `Product ${index}.brand`);
    if (item.code != null && typeof item.code !== "string") {
      throw invalidResponse(endpoint, `Product ${index}.code must be a string`);
    }
    if (item.nameRu != null && typeof item.nameRu !== "string") {
      throw invalidResponse(endpoint, `Product ${index}.nameRu must be a string`);
    }
    requireFiniteNumber(item.price, endpoint, `Product ${index}.price`, { min: 0 });
    if (item.old != null) requireFiniteNumber(item.old, endpoint, `Product ${index}.old`, { min: 0 });
    if (item.stock != null) requireFiniteNumber(item.stock, endpoint, `Product ${index}.stock`, { min: 0 });
    if (item.image != null && typeof item.image !== "string") {
      throw invalidResponse(endpoint, `Product ${index}.image must be a string`);
    }
    if (item.specs != null) {
      if (!Array.isArray(item.specs)) throw invalidResponse(endpoint, `Product ${index}.specs must be an array`);
      for (const [specIndex, spec] of item.specs.entries()) {
        requireObject(spec, endpoint, `Product ${index}.specs[${specIndex}]`);
        requireString(spec.label, endpoint, `Product ${index}.specs[${specIndex}].label`);
        requireString(spec.value, endpoint, `Product ${index}.specs[${specIndex}].value`);
      }
    }
    for (const flag of ["isNew", "promo", "summer"]) {
      if (item[flag] != null && typeof item[flag] !== "boolean") {
        throw invalidResponse(endpoint, `Product ${index}.${flag} must be a boolean`);
      }
    }
    if (keys.has(key)) throw invalidResponse(endpoint, `Duplicate product key: ${key}`);
    if (!categoryIds.has(categoryId)) {
      throw invalidResponse(endpoint, `Product ${key} references unknown category: ${categoryId}`);
    }
    keys.add(key);
    return item;
  });
}

export async function loadStorefrontCatalog({
  fetchImpl = globalThis.fetch,
  productsEndpoint = PRODUCTS_ENDPOINT,
  categoriesEndpoint = CATEGORIES_ENDPOINT,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new CatalogApiError("CATALOG_API_UNAVAILABLE", "Fetch is not available");
  }

  const [rawProducts, rawCategories] = await Promise.all([
    requestCollection(fetchImpl, productsEndpoint, "Products"),
    requestCollection(fetchImpl, categoriesEndpoint, "Categories"),
  ]);
  const categories = validateCategories(rawCategories, categoriesEndpoint);
  const categoryIds = new Set(categories.map((category) => category.id.trim()));
  const products = validateProducts(rawProducts, productsEndpoint, categoryIds);
  return { products, categories };
}
