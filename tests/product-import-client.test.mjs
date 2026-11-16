import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inferProductBrand,
  inferProductSpecs,
  formatProductImportError,
  parseProductImportRows,
  previewProductImport,
  productImportPayload,
  removeProductImportRow,
  suggestImportCategory,
} from '../src/product-import.js';

test('parses the Microinvest stock report used by the seller', () => {
  const parsed = parseProductImportRows([
    ['Отчет Количества товаров'],
    ['Код', 'Товар', 'Группа', 'Ед. изм.', "Количество 'MAGAZIN'", 'Пересчитано'],
    [329176, 'Wild-Mild Base Shield Smoothing Base Coat 12ml', 'LACURI SIMPLE', 'шт.', 10, ''],
  ], 'Microinvest');

  assert.equal(parsed.rowCount, 1);
  assert.equal(parsed.errors.length, 0);
  assert.deepEqual(parsed.availableFields.sort(), ['group', 'name', 'sku', 'stock']);
  assert.deepEqual(parsed.items[0], {
    sheetRow: 3,
    sku: '329176',
    nameRo: 'Wild-Mild Base Shield Smoothing Base Coat 12ml',
    brand: 'Wild-Mild',
    brandProvided: false,
    price: null,
    priceProvided: false,
    stock: 10,
    stockProvided: true,
    sourceGroup: 'LACURI SIMPLE',
    isActive: null,
    stateProvided: false,
    descriptionRo: '',
    descriptionProvided: false,
    imageUrl: '',
    imageProvided: false,
    specs: [{ label: 'Cantitate', value: '12 ml' }],
    categoryId: '',
  });
});

test('accepts optional product-card columns and sends them to the import API', () => {
  const parsed = parseProductImportRows([
    ['Код', 'Товар', 'Группа', 'Бренд', 'Цена', 'Количество магазина', 'Описание', 'Фото', 'Состояние'],
    ['3407', 'Valeri Builder Gel 15ml №01', 'GELURI', 'Valeri', 145, 6, 'Gel autonivelant', 'https://images.example/3407.webp', 'Товар доступен'],
  ]);
  const preview = previewProductImport(parsed.items, { GELURI: 'alungire' }, []);
  assert.equal(preview.entries[0].action, 'create');
  assert.deepEqual(productImportPayload(preview.entries[0]), {
    sheetRow: 2,
    sku: '3407',
    categoryId: 'alungire',
    brand: 'Valeri',
    nameRo: 'Valeri Builder Gel 15ml №01',
    price: 145,
    stock: 6,
    isActive: true,
    specs: [{ label: 'Cantitate', value: '15 ml' }],
    descriptionRo: 'Gel autonivelant',
    descriptionProvided: true,
    imageUrl: 'https://images.example/3407.webp',
    imageProvided: true,
  });
});

test('recognizes the Link imagine column used by the Valeri import file', () => {
  const parsed = parseProductImportRows([
    ['Sku', 'Produs', 'Categorie', 'Stoc', 'Pret', 'Link imagine', 'Descriere'],
    [
      'TT0537',
      'DANNY Flash Crystal Gel Polish 10ml №49',
      'Gel Lac',
      2,
      110,
      'https://dannytiny.ua/content/images/50/1280x1280l80mc0/15417039949125.webp',
      'Gel-lac reflectorizant.',
    ],
  ], 'Microinvest');

  assert.equal(parsed.rowCount, 1);
  assert.equal(parsed.availableFields.includes('image'), true);
  assert.equal(parsed.items[0].imageProvided, true);
  assert.equal(
    parsed.items[0].imageUrl,
    'https://dannytiny.ua/content/images/50/1280x1280l80mc0/15417039949125.webp',
  );
});

test('editable preview reports duplicate codes and missing prices for new products', () => {
  const parsed = parseProductImportRows([
    ['Код', 'Товар', 'Группа', 'Цена'],
    ['A-1', 'DANNY Gel 15ml', 'GELURI', 100],
    ['a-1', 'DANNY Gel 30ml', 'GELURI', 120],
    ['A-2', 'BeeNails Gel 5ml', 'GELURI', 12.5],
  ]);
  const preview = previewProductImport(parsed.items, { GELURI: 'alungire' }, []);
  assert.equal(parsed.items.length, 3);
  assert.equal(preview.counts.error, 3);
  assert.equal(preview.entries.filter((entry) => entry.validationErrors.includes('SKU duplicat')).length, 2);
  assert.equal(preview.entries.some((entry) => entry.validationErrors.includes('Preț invalid')), true);
});

test('preview preserves omitted existing fields and detects stock changes', () => {
  const categories = [{ id: 'alungire', slug: 'alungire', name_ro: 'Alungire' }];
  assert.equal(suggestImportCategory('GEL LICHID', categories), 'alungire');
  assert.equal(inferProductBrand('BeeNails Aurora'), 'BeeNails');
  assert.deepEqual(inferProductSpecs('Produs fără volum'), []);

  const items = [{
    sheetRow: 4, sku: 'OLD-1', nameRo: 'DANNY Gel', brand: 'DANNY', price: null,
    stock: 8, sourceGroup: 'GELURI', isActive: null, specs: [], imageUrl: '',
    imageProvided: false, descriptionRo: '', descriptionProvided: false, categoryId: '',
  }];
  const products = [{
    sku: 'old-1', categoryId: 'alungire', name: 'DANNY Gel', brand: 'DANNY', price: 120,
    onHand: 3, isActive: true, isDeleted: false, image: 'https://images.example/old.webp',
  }];
  const preview = previewProductImport(items, { GELURI: 'alungire' }, products);
  assert.equal(preview.entries[0].price, 120);
  assert.equal(preview.entries[0].imageUrl, 'https://images.example/old.webp');
  assert.deepEqual(preview.counts, { create: 0, update: 1, unchanged: 0, error: 0 });
});

test('preview blocks stock below the reserved quantity', () => {
  const items = [{
    sheetRow: 52, sku: 'SKU-52', nameRo: 'DANNY Gel', brand: 'DANNY', price: 120,
    stock: 2, sourceGroup: 'GELURI', isActive: true, specs: [], imageUrl: '',
    imageProvided: false, descriptionRo: '', descriptionProvided: false, categoryId: '',
  }];
  const products = [{
    sku: 'sku-52', categoryId: 'alungire', name: 'DANNY Gel', brand: 'DANNY', price: 120,
    onHand: 5, reserved: 3, isActive: true, isDeleted: false, image: '',
  }];

  const blocked = previewProductImport(items, { GELURI: 'alungire' }, products);
  assert.equal(blocked.entries[0].action, 'error');
  assert.deepEqual(blocked.entries[0].validationErrors, [
    'Stocul importat (2) este mai mic decât stocul rezervat (3)',
  ]);

  const allowed = previewProductImport([{ ...items[0], stock: 3 }], { GELURI: 'alungire' }, products);
  assert.equal(allowed.entries[0].action, 'update');
});

test('formats reserved-stock API errors with the affected spreadsheet row and values', () => {
  const message = formatProductImportError({
    code: 'INVALID_PRODUCT_IMPORT_STOCK',
    message: 'Imported stock cannot be lower than reserved stock',
    details: { sheetRow: 52, sku: 'SKU-52', reserved: 3 },
  }, [{ sheetRow: 52, sku: 'SKU-52', stock: 2 }]);

  assert.equal(
    message,
    'Rândul 52 · SKU SKU-52: Stocul importat (2) este mai mic decât stocul rezervat (3).',
  );
  assert.equal(formatProductImportError({ message: 'Altă eroare' }), 'Altă eroare');
});

test('a row removed from the editable preview is excluded from the import and its summary', () => {
  const parsed = parseProductImportRows([
    ['Код', 'Товар', 'Группа', 'Цена'],
    ['A-1', 'DANNY Gel 15ml', 'GELURI', 100],
    ['B-1', 'BeeNails Base 10ml', 'BAZE', 120],
  ], 'Microinvest');

  const next = removeProductImportRow(parsed, 2);

  assert.equal(next.rowCount, 1);
  assert.deepEqual(next.items.map((item) => item.sku), ['B-1']);
  assert.deepEqual(next.groups, ['BAZE']);
  assert.equal(previewProductImport(next.items, { BAZE: 'baze' }, []).entries.length, 1);
  assert.equal(removeProductImportRow(next, 999), next);
});
