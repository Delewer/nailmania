const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 500;
export const PRODUCT_IMPORT_CHUNK_SIZE = 10;

const REQUIRED_HEADERS = {
  sku: 'код',
  name: 'товар',
  price: 'розничная цена',
  group: 'группа',
  state: 'состояние',
};

const normalizedText = (value) => String(value ?? '')
  .normalize('NFC')
  .trim()
  .replace(/\s+/g, ' ');
const normalizedHeader = (value) => normalizedText(value).toLocaleLowerCase('ru');
const skuIdentity = (value) => normalizedText(value).toLocaleUpperCase('en-US');

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

function parsePrice(value) {
  const normalized = typeof value === 'number'
    ? value
    : Number(normalizedText(value).replaceAll(' ', '').replace(',', '.'));
  return Number.isInteger(normalized) && normalized >= 0 ? normalized : null;
}

function parseActiveState(value) {
  const state = normalizedHeader(value);
  if (['товар доступен', 'доступен', 'activ', 'active', 'da', 'yes', '1'].includes(state)) return true;
  if (['товар недоступен', 'товар не доступен', 'недоступен', 'inactiv', 'inactive', 'nu', 'no', '0'].includes(state)) return false;
  return null;
}

function locateHeader(rows) {
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 20); rowIndex += 1) {
    const indexes = new Map((rows[rowIndex] || []).map((value, index) => [normalizedHeader(value), index]));
    if (Object.values(REQUIRED_HEADERS).every((header) => indexes.has(header))) {
      return {
        rowIndex,
        columns: Object.fromEntries(
          Object.entries(REQUIRED_HEADERS).map(([field, header]) => [field, indexes.get(header)]),
        ),
      };
    }
  }
  return null;
}

export function parseProductImportRows(rows, sheetName = '') {
  if (!Array.isArray(rows)) throw new TypeError('Rândurile foii Excel sunt invalide');
  const header = locateHeader(rows);
  if (!header) {
    throw new Error('Nu am găsit coloanele „Код”, „Товар”, „Розничная цена”, „Группа” și „Состояние”');
  }
  const sourceRows = rows
    .slice(header.rowIndex + 1)
    .map((cells, index) => ({ cells: Array.isArray(cells) ? cells : [], sheetRow: header.rowIndex + index + 2 }))
    .filter(({ cells }) => ['sku', 'name', 'group', 'state']
      .some((field) => normalizedText(cells[header.columns[field]])));
  if (sourceRows.length > MAX_IMPORT_ROWS) {
    throw new Error(`Fișierul conține ${sourceRows.length} produse; limita este ${MAX_IMPORT_ROWS}`);
  }

  const items = [];
  const errors = [];
  for (const { cells, sheetRow } of sourceRows) {
    const sku = normalizedText(cells[header.columns.sku]);
    const nameRo = normalizedText(cells[header.columns.name]);
    const price = parsePrice(cells[header.columns.price]);
    const sourceGroup = normalizedText(cells[header.columns.group]);
    const isActive = parseActiveState(cells[header.columns.state]);
    const rowErrors = [];
    if (!sku || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sku)) rowErrors.push({ field: 'Код', message: 'Codul trebuie să conțină doar litere, cifre, punct, cratimă sau underscore' });
    if (nameRo.length < 2) rowErrors.push({ field: 'Товар', message: 'Denumirea produsului lipsește' });
    if (price === null) rowErrors.push({ field: 'Розничная цена', message: 'Prețul trebuie să fie zero sau un număr întreg pozitiv' });
    if (!sourceGroup) rowErrors.push({ field: 'Группа', message: 'Grupa lipsește' });
    if (isActive === null) rowErrors.push({ field: 'Состояние', message: 'Starea produsului nu este recunoscută' });
    if (rowErrors.length) {
      errors.push(...rowErrors.map((error) => ({ row: sheetRow, sku, ...error })));
      continue;
    }
    items.push({
      sheetRow,
      sku,
      nameRo,
      brand: inferProductBrand(nameRo),
      price,
      sourceGroup,
      isActive,
      specs: inferProductSpecs(nameRo),
    });
  }

  const duplicates = new Map();
  for (const item of items) {
    const identity = skuIdentity(item.sku);
    duplicates.set(identity, [...(duplicates.get(identity) || []), item]);
  }
  const duplicateRows = new Set();
  for (const entries of duplicates.values()) {
    if (entries.length < 2) continue;
    for (const item of entries) {
      duplicateRows.add(item.sheetRow);
      errors.push({ row: item.sheetRow, sku: item.sku, field: 'Код', message: 'Cod duplicat în fișier' });
    }
  }

  return {
    sheetName,
    items: items.filter((item) => !duplicateRows.has(item.sheetRow)),
    errors,
    groups: [...new Set(items.map((item) => item.sourceGroup))].sort((a, b) => a.localeCompare(b)),
    rowCount: sourceRows.length,
  };
}

export async function readProductImportFile(file) {
  if (!file) throw new Error('Selectați un fișier Excel');
  if (file.size > MAX_FILE_BYTES) throw new Error('Fișierul Excel nu poate depăși 5 MB');
  if (!/\.(?:xls|xlsx)$/i.test(file.name || '')) throw new Error('Sunt acceptate doar fișiere .xls sau .xlsx');
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(await file.arrayBuffer(), {
    type: 'array',
    dense: true,
    sheetRows: MAX_IMPORT_ROWS + 22,
    cellFormula: false,
    cellHTML: false,
    cellNF: false,
    cellStyles: false,
    bookVBA: false,
  });
  for (const sheetName of workbook.SheetNames || []) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      raw: true,
      defval: '',
      blankrows: true,
    });
    if (locateHeader(rows)) return parseProductImportRows(rows, sheetName);
  }
  throw new Error('Nicio foaie nu conține coloanele necesare importului');
}

export function suggestImportCategory(sourceGroup, categories) {
  const group = normalizedHeader(sourceGroup);
  const exact = (categories || []).find((category) => [category.id, category.slug, category.name_ro]
    .some((value) => normalizedHeader(value) === group));
  if (exact) return exact.id;
  if (group.includes('gel')) {
    return (categories || []).find((category) => category.id === 'alungire')?.id || '';
  }
  return '';
}

export function previewProductImport(items, categoryMappings, products) {
  const existingBySku = new Map((products || []).map((product) => [skuIdentity(product.sku), product]));
  const entries = (items || []).map((item) => {
    const categoryId = String(categoryMappings?.[item.sourceGroup] || '');
    const existing = existingBySku.get(skuIdentity(item.sku));
    if (!categoryId) return { ...item, categoryId, existing, action: 'error' };
    if (!existing) return { ...item, categoryId, existing: null, action: 'create' };
    const changed = String(existing.categoryId || '') !== categoryId
      || normalizedText(existing.name) !== item.nameRo
      || normalizedText(existing.brand) !== item.brand
      || Number(existing.price) !== item.price
      || Boolean(existing.isActive) !== item.isActive
      || Boolean(existing.isDeleted);
    return { ...item, categoryId, existing, action: changed ? 'update' : 'unchanged' };
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
    price: entry.price,
    isActive: entry.isActive,
    specs: entry.specs,
  };
}
