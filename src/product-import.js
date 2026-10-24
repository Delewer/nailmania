const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 500;
export const PRODUCT_IMPORT_CHUNK_SIZE = 25;

const HEADER_ALIASES = {
  sku: ['код', 'sku', 'cod', 'cod produs', 'articol'],
  name: ['товар', 'produs', 'denumire', 'nume produs', 'name'],
  group: ['группа', 'grupa', 'categorie', 'category'],
  price: ['розничная цена', 'цена', 'pret', 'preț', 'price', 'pret vanzare', 'pret de vanzare'],
  stock: ["количество 'magazin'", 'количество magazin', 'количество магазина', 'остаток', 'сток', 'stock', 'stoc', 'cantitate', 'quantity'],
  brand: ['бренд', 'brand', 'marca'],
  description: ['описание', 'description', 'descriere'],
  image: ['фото', 'photo', 'foto', 'imagine', 'image', 'ссылка на фото', 'link foto', 'link imagine', 'image url', 'url imagine'],
  state: ['состояние', 'state', 'status', 'stare', 'activ'],
};
const REQUIRED_FIELDS = ['sku', 'name', 'group'];

const normalizedText = (value) => String(value ?? '')
  .normalize('NFC')
  .trim()
  .replace(/\s+/g, ' ');
const normalizedHeader = (value) => normalizedText(value)
  .normalize('NFKC')
  .toLocaleLowerCase('ru')
  .replace(/[’‘`´]/g, "'")
  .replace(/\s+/g, ' ');
const skuIdentity = (value) => normalizedText(value).toLocaleUpperCase('en-US');
const hasValue = (value) => normalizedText(value) !== '';

export function inferProductBrand(name) {
  const first = normalizedText(name).split(' ')[0] || '';
  const aliases = new Map([
    ['dnka', "DNK'a"],
    ['danny', 'DANNY'],
    ['valeri', 'Valeri'],
    ['beenails', 'BeeNails'],
  ]);
  return aliases.get(first.toLocaleLowerCase('en-US')) || first || 'Fără brand';
}

export function inferProductSpecs(name) {
  const volume = normalizedText(name).match(/(?:^|\s)(\d+(?:[.,]\d+)?)\s*ml\b/i)?.[1];
  return volume ? [{ label: 'Cantitate', value: `${volume.replace(',', '.')} ml` }] : [];
}

function parseInteger(value) {
  if (!hasValue(value)) return null;
  const normalized = typeof value === 'number'
    ? value
    : Number(normalizedText(value).replaceAll(' ', '').replace(',', '.'));
  return Number.isInteger(normalized) && normalized >= 0 ? normalized : null;
}

function parseActiveState(value) {
  if (!hasValue(value)) return null;
  const state = normalizedHeader(value);
  if (['товар доступен', 'доступен', 'activ', 'active', 'da', 'yes', '1'].includes(state)) return true;
  if (['товар недоступен', 'товар не доступен', 'недоступен', 'inactiv', 'inactive', 'nu', 'no', '0'].includes(state)) return false;
  return null;
}

function locateHeader(rows) {
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 20); rowIndex += 1) {
    const indexes = new Map((rows[rowIndex] || []).map((value, index) => [normalizedHeader(value), index]));
    const columns = {};
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      const alias = aliases.find((candidate) => indexes.has(normalizedHeader(candidate)));
      if (alias) columns[field] = indexes.get(normalizedHeader(alias));
    }
    if (REQUIRED_FIELDS.every((field) => Number.isInteger(columns[field]))) return { rowIndex, columns };
  }
  return null;
}

export function parseProductImportRows(rows, sheetName = '') {
  if (!Array.isArray(rows)) throw new TypeError('Rândurile foii Excel sunt invalide');
  const header = locateHeader(rows);
  if (!header) throw new Error('Nu am găsit coloanele „Код”, „Товар” și „Группа”');
  const sourceRows = rows
    .slice(header.rowIndex + 1)
    .map((cells, index) => ({ cells: Array.isArray(cells) ? cells : [], sheetRow: header.rowIndex + index + 2 }))
    .filter(({ cells }) => Object.values(header.columns).some((column) => hasValue(cells[column])));
  if (sourceRows.length > MAX_IMPORT_ROWS) {
    throw new Error(`Fișierul conține ${sourceRows.length} produse; limita este ${MAX_IMPORT_ROWS}`);
  }

  const value = (cells, field) => Number.isInteger(header.columns[field]) ? cells[header.columns[field]] : '';
  const items = sourceRows.map(({ cells, sheetRow }) => {
    const nameRo = normalizedText(value(cells, 'name'));
    const brandProvided = hasValue(value(cells, 'brand'));
    return {
      sheetRow,
      sku: normalizedText(value(cells, 'sku')),
      nameRo,
      brand: brandProvided ? normalizedText(value(cells, 'brand')) : inferProductBrand(nameRo),
      brandProvided,
      price: parseInteger(value(cells, 'price')),
      priceProvided: hasValue(value(cells, 'price')),
      stock: parseInteger(value(cells, 'stock')),
      stockProvided: hasValue(value(cells, 'stock')),
      sourceGroup: normalizedText(value(cells, 'group')),
      isActive: parseActiveState(value(cells, 'state')),
      stateProvided: hasValue(value(cells, 'state')),
      descriptionRo: normalizedText(value(cells, 'description')),
      descriptionProvided: hasValue(value(cells, 'description')),
      imageUrl: normalizedText(value(cells, 'image')),
      imageProvided: hasValue(value(cells, 'image')),
      specs: inferProductSpecs(nameRo),
      categoryId: '',
    };
  });

  return {
    sheetName,
    items,
    errors: [],
    groups: [...new Set(items.map((item) => item.sourceGroup).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    rowCount: sourceRows.length,
    availableFields: Object.keys(header.columns),
  };
}

export async function readProductImportFile(file) {
  if (!file) throw new Error('Selectați un fișier Excel');
  if (file.size > MAX_FILE_BYTES) throw new Error('Fișierul Excel nu poate depăși 5 MB');
  if (!/\.(?:xls|xlsx)$/i.test(file.name || '')) throw new Error('Sunt acceptate doar fișiere .xls sau .xlsx');
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(await file.arrayBuffer(), {
    type: 'array', dense: true, sheetRows: MAX_IMPORT_ROWS + 22,
    cellFormula: false, cellHTML: false, cellNF: false, cellStyles: false, bookVBA: false,
  });
  for (const sheetName of workbook.SheetNames || []) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1, raw: true, defval: '', blankrows: true,
    });
    if (locateHeader(rows)) return parseProductImportRows(rows, sheetName);
  }
  throw new Error('Nicio foaie nu conține coloanele necesare importului');
}

export function suggestImportCategory(sourceGroup, categories) {
  const group = normalizedHeader(sourceGroup);
  const exact = (categories || []).find((category) => [category.id, category.slug, category.name_ro, category.nameRo]
    .some((value) => normalizedHeader(value) === group));
  if (exact) return exact.id;
  if (group.includes('gel')) return (categories || []).find((category) => category.id === 'alungire')?.id || '';
  return '';
}

const validHttpUrl = (value) => {
  if (!normalizedText(value)) return true;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); }
  catch { return false; }
};

export function previewProductImport(items, categoryMappings, products) {
  const existingBySku = new Map((products || []).map((product) => [skuIdentity(product.sku), product]));
  const duplicateSkus = new Map();
  for (const item of items || []) {
    const identity = skuIdentity(item.sku);
    if (identity) duplicateSkus.set(identity, (duplicateSkus.get(identity) || 0) + 1);
  }
  const entries = (items || []).map((item) => {
    const existing = existingBySku.get(skuIdentity(item.sku));
    const categoryId = String(item.categoryId || categoryMappings?.[item.sourceGroup] || existing?.categoryId || '');
    const resolved = {
      ...item,
      categoryId,
      existing: existing || null,
      price: item.price ?? existing?.price ?? null,
      stock: item.stock ?? existing?.onHand ?? 0,
      isActive: typeof item.isActive === 'boolean' ? item.isActive : (existing?.isActive ?? true),
      brand: normalizedText(item.brand) || normalizedText(existing?.brand) || inferProductBrand(item.nameRo),
      imageUrl: item.imageProvided ? normalizedText(item.imageUrl) : (normalizedText(item.imageUrl) || normalizedText(existing?.image)),
    };
    const validationErrors = [];
    if (!resolved.sku || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(resolved.sku)) validationErrors.push('SKU invalid');
    if (duplicateSkus.get(skuIdentity(resolved.sku)) > 1) validationErrors.push('SKU duplicat');
    if (normalizedText(resolved.nameRo).length < 2) validationErrors.push('Denumire lipsă');
    if (!resolved.categoryId) validationErrors.push('Categorie lipsă');
    if (resolved.price === null || resolved.price === '' || !Number.isInteger(Number(resolved.price)) || Number(resolved.price) < 0) validationErrors.push('Preț invalid');
    if (!Number.isInteger(Number(resolved.stock)) || Number(resolved.stock) < 0) validationErrors.push('Stoc invalid');
    if (!validHttpUrl(resolved.imageUrl)) validationErrors.push('Link imagine invalid');
    if (validationErrors.length) return { ...resolved, validationErrors, action: 'error' };
    if (!existing) return { ...resolved, validationErrors, action: 'create' };
    const changed = String(existing.categoryId || '') !== resolved.categoryId
      || normalizedText(existing.name) !== normalizedText(resolved.nameRo)
      || normalizedText(existing.brand) !== normalizedText(resolved.brand)
      || Number(existing.price) !== Number(resolved.price)
      || Number(existing.onHand || 0) !== Number(resolved.stock)
      || Boolean(existing.isActive) !== resolved.isActive
      || Boolean(existing.isDeleted)
      || Boolean(resolved.descriptionProvided)
      || (Boolean(resolved.imageProvided) && normalizedText(existing.image) !== normalizedText(resolved.imageUrl));
    return { ...resolved, validationErrors, action: changed ? 'update' : 'unchanged' };
  });
  return {
    entries,
    counts: entries.reduce((counts, entry) => ({ ...counts, [entry.action]: counts[entry.action] + 1 }), {
      create: 0, update: 0, unchanged: 0, error: 0,
    }),
  };
}

export function productImportPayload(entry) {
  return {
    sheetRow: entry.sheetRow,
    sku: entry.sku,
    categoryId: entry.categoryId,
    brand: entry.brand,
    nameRo: entry.nameRo,
    price: Number(entry.price),
    stock: Number(entry.stock),
    isActive: entry.isActive,
    specs: entry.specs,
    descriptionRo: entry.descriptionRo || '',
    descriptionProvided: Boolean(entry.descriptionProvided),
    imageUrl: entry.imageUrl || '',
    imageProvided: Boolean(entry.imageProvided),
  };
}
