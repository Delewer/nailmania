import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inferProductBrand,
  inferProductSpecs,
  parseProductImportRows,
  previewProductImport,
  suggestImportCategory,
} from '../src/product-import.js';

const header = [
  '', 'Код', 'Товар', '', '', '', '', 'Приходная цена', '', '', 'Розничная цена',
  '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'Группа', 'Состояние',
];

const row = ({ sku, name, cost, price, group = 'GELURI', state = 'Товар доступен' }) => {
  const cells = Array.from({ length: 29 }, () => '');
  cells[1] = sku;
  cells[2] = name;
  cells[7] = cost;
  cells[10] = price;
  cells[27] = group;
  cells[28] = state;
  return cells;
};

test('Excel product parser uses only storefront fields and accepts numeric SKU values', () => {
  const parsed = parseProductImportRows([
    ['Microinvest export'],
    [],
    header,
    row({ sku: 3407, name: 'Valeri Builder Gel 15ml №01', cost: 83, price: 145 }),
    row({ sku: 'DNKA-01', name: 'DNKa Liquid Acrygel 12 ml', cost: 92, price: 180, state: 'Товар недоступен' }),
  ], 'Microinvest');

  assert.equal(parsed.rowCount, 2);
  assert.equal(parsed.errors.length, 0);
  assert.deepEqual(parsed.items[0], {
    sheetRow: 4,
    sku: '3407',
    nameRo: 'Valeri Builder Gel 15ml №01',
    brand: 'Valeri',
    price: 145,
    sourceGroup: 'GELURI',
    isActive: true,
    specs: [{ label: 'Cantitate', value: '15 ml' }],
  });
  assert.equal(Object.hasOwn(parsed.items[0], 'costPrice'), false);
  assert.equal(parsed.items[1].brand, "DNK'a");
  assert.equal(parsed.items[1].isActive, false);
});

test('parser reports duplicate product codes and invalid retail prices', () => {
  const parsed = parseProductImportRows([
    header,
    row({ sku: 'A-1', name: 'DANNY Gel 15ml', cost: 20, price: 100 }),
    row({ sku: 'a-1', name: 'DANNY Gel 30ml', cost: 30, price: 120 }),
    row({ sku: 'A-2', name: 'BeeNails Gel 5ml', cost: 40, price: 12.5 }),
  ]);

  assert.equal(parsed.items.length, 0);
  assert.equal(parsed.errors.filter((error) => error.message.includes('duplicat')).length, 2);
  assert.equal(parsed.errors.some((error) => error.field === 'Розничная цена'), true);
});

test('preview maps gel groups and separates create, update and unchanged actions', () => {
  const categories = [{ id: 'alungire', slug: 'alungire', name_ro: 'Alungire' }];
  assert.equal(suggestImportCategory('GEL LICHID', categories), 'alungire');
  assert.equal(inferProductBrand('BeeNails Aurora'), 'BeeNails');
  assert.deepEqual(inferProductSpecs('Produs fără volum'), []);

  const items = [
    { sheetRow: 4, sku: 'NEW-1', nameRo: 'Valeri Gel', brand: 'Valeri', price: 145, sourceGroup: 'GELURI', isActive: true, specs: [] },
    { sheetRow: 5, sku: 'OLD-1', nameRo: 'DANNY Gel', brand: 'DANNY', price: 120, sourceGroup: 'GELURI', isActive: true, specs: [] },
    { sheetRow: 6, sku: 'SAME-1', nameRo: 'BeeNails Gel', brand: 'BeeNails', price: 90, sourceGroup: 'GELURI', isActive: true, specs: [] },
  ];
  const products = [
    { sku: 'OLD-1', categoryId: 'alungire', name: 'DANNY Gel vechi', brand: 'DANNY', price: 100, isActive: true, isDeleted: false },
    { sku: 'same-1', categoryId: 'alungire', name: 'BeeNails Gel', brand: 'BeeNails', price: 90, isActive: true, isDeleted: false },
  ];
  const preview = previewProductImport(items, { GELURI: 'alungire' }, products);

  assert.deepEqual(preview.counts, { create: 1, update: 1, unchanged: 1, error: 0 });
});
