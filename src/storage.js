const availableStorage = (storage) => {
  try { return storage || globalThis.localStorage || null; }
  catch { return null; }
};

export const readStoredValue = (key, fallback = '', storage = null) => {
  try { return availableStorage(storage)?.getItem(key) ?? fallback; }
  catch { return fallback; }
};

export const writeStoredValue = (key, value, storage = null) => {
  try { availableStorage(storage)?.setItem(key, value); return true; }
  catch { return false; }
};

export const readStoredList = (key, storage = null) => {
  try {
    const parsed = JSON.parse(readStoredValue(key, '[]', storage));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};
