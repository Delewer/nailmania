export function catalogImageUrls(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.flatMap((entry) => String(entry || '')
    // The catalog contract uses whitespace between URLs. Commas can be a
    // meaningful part of a URL query and must never be treated as separators.
    .split(/\s+/)
    .filter(Boolean)))];
}

export function isValidCatalogImageUrl(value) {
  if (/,(?:https?):\/\//i.test(String(value || ''))) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      && Boolean(url.hostname)
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}
