import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_REDIRECTS = 5;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export function sniffSupportedImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return { ext: 'jpg', contentType: 'image/jpeg' };
  }
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return { ext: 'png', contentType: 'image/png' };
  }
  if (buffer.slice(0, 4).toString('latin1') === 'RIFF'
      && buffer.slice(8, 12).toString('latin1') === 'WEBP') {
    return { ext: 'webp', contentType: 'image/webp' };
  }
  if (buffer.slice(0, 3).toString('latin1') === 'GIF') {
    return { ext: 'gif', contentType: 'image/gif' };
  }
  if (buffer.slice(4, 8).toString('latin1') === 'ftyp'
      && ['avif', 'avis'].includes(buffer.slice(8, 12).toString('latin1'))) {
    return { ext: 'avif', contentType: 'image/avif' };
  }
  return null;
}

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  blockedAddresses.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
]) {
  blockedAddresses.addSubnet(network, prefix, 'ipv6');
}

const unbracketedAddress = (value) => String(value || '')
  .trim()
  .replace(/^\[|\]$/g, '')
  .replace(/%.+$/, '');

export function assertPublicNetworkAddress(value) {
  const address = unbracketedAddress(value);
  const family = isIP(address);
  if (!family) throw new Error(`External image host resolved to an invalid IP address: ${value}`);
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (family === 6 && (
    address.toLowerCase().startsWith('::ffff:')
    || /^(?:0+:){5}ffff:/i.test(address)
  )) {
    throw new Error('External image URL resolves to a blocked ipv4-mapped address');
  }
  if (blockedAddresses.check(address, type)) {
    throw new Error(`External image URL resolves to a blocked ${type} address`);
  }
  return { address, family };
}

export function parsePublicHttpUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error('External image URL must be an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)
      || !url.hostname
      || url.username
      || url.password) {
    throw new Error('External image URL must be HTTP(S) without credentials');
  }
  return url;
}

export async function resolvePublicHost(hostname, { lookup = dnsLookup } = {}) {
  const literal = unbracketedAddress(hostname);
  if (isIP(literal)) return [assertPublicNetworkAddress(literal)];

  let records;
  try {
    records = await lookup(literal, { all: true, verbatim: true });
  } catch (error) {
    throw new Error(`External image DNS lookup failed: ${error?.message || error}`);
  }
  const values = Array.isArray(records) ? records : [records];
  if (!values.length) throw new Error('External image DNS lookup returned no addresses');

  const resolved = values.map((record) => assertPublicNetworkAddress(record?.address));
  return [...new Map(resolved.map((record) => [
    `${record.family}:${record.address}`,
    record,
  ])).values()];
}

function singleHeaderValue(headers, name) {
  const raw = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (raw === undefined) return '';
  if (Array.isArray(raw)) {
    if (raw.length !== 1) throw new Error(`External image response has multiple ${name} headers`);
    return String(raw[0]);
  }
  return String(raw);
}

export async function readBoundedResponseBody(response, {
  maxBytes = DEFAULT_MAX_IMAGE_BYTES,
} = {}) {
  const rawLength = singleHeaderValue(response.headers, 'content-length').trim();
  if (rawLength) {
    if (!/^\d+$/.test(rawLength)) {
      throw new Error('External image response has an invalid Content-Length');
    }
    const declared = Number(rawLength);
    if (!Number.isSafeInteger(declared) || declared > maxBytes) {
      throw new Error(`External image exceeds the ${maxBytes}-byte limit`);
    }
  }

  const chunks = [];
  let bytes = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      response.destroy?.();
      throw new Error(`External image exceeds the ${maxBytes}-byte streaming limit`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes);
}

function requestSingleResolvedUrl({
  url,
  selected,
  headers = {},
  maxBytes = DEFAULT_MAX_IMAGE_BYTES,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  const parsed = parsePublicHttpUrl(url);
  const client = parsed.protocol === 'https:' ? https : http;
  const literalHostname = unbracketedAddress(parsed.hostname);
  const options = {
    protocol: parsed.protocol,
    hostname: literalHostname,
    port: parsed.port || undefined,
    path: `${parsed.pathname}${parsed.search}`,
    method: 'GET',
    agent: false,
    family: selected.family,
    headers: {
      ...headers,
      Host: parsed.host,
    },
    lookup: (_hostname, lookupOptions, callback) => {
      if (lookupOptions?.all) {
        callback(null, [{ address: selected.address, family: selected.family }]);
      } else {
        callback(null, selected.address, selected.family);
      }
    },
    ...(parsed.protocol === 'https:' && !isIP(literalHostname)
      ? { servername: literalHostname }
      : {}),
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const request = client.request(options, (response) => {
      const statusCode = Number(response.statusCode || 0);
      const responseHeaders = response.headers || {};
      const isSuccess = statusCode >= 200 && statusCode < 300;
      if (!isSuccess) {
        finish(resolve, { statusCode, headers: responseHeaders, body: null });
        response.destroy();
        return;
      }
      readBoundedResponseBody(response, { maxBytes }).then(
        (body) => finish(resolve, { statusCode, headers: responseHeaders, body }),
        (error) => {
          finish(reject, error);
          response.destroy();
          request.destroy();
        },
      );
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('External image request timed out'));
    });
    request.on('error', (error) => finish(reject, error));
    request.end();
  });
}

export async function requestResolvedUrl(options) {
  if (!options.addresses?.length) {
    throw new Error('External image request has no verified public address');
  }
  let lastError;
  for (const selected of options.addresses) {
    try {
      return await requestSingleResolvedUrl({ ...options, selected });
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`External image request failed on every verified address: ${lastError?.message || lastError}`);
}

const redirectStatus = (status) => [301, 302, 303, 307, 308].includes(status);

export async function fetchPublicImage(value, {
  lookup = dnsLookup,
  requester = requestResolvedUrl,
  headers = {},
  maxBytes = DEFAULT_MAX_IMAGE_BYTES,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  let current = parsePublicHttpUrl(value);
  const seen = new Set();
  for (let redirects = 0; ; redirects++) {
    if (seen.has(current.href)) throw new Error('External image redirect loop detected');
    seen.add(current.href);

    const addresses = await resolvePublicHost(current.hostname, { lookup });
    const response = await requester({
      url: current.href,
      addresses,
      headers,
      maxBytes,
      timeoutMs,
    });
    const statusCode = Number(response?.statusCode || 0);
    if (redirectStatus(statusCode)) {
      if (redirects >= maxRedirects) {
        throw new Error(`External image exceeded ${maxRedirects} redirects`);
      }
      const location = singleHeaderValue(response.headers, 'location').trim();
      if (!location) throw new Error('External image redirect is missing Location');
      current = parsePublicHttpUrl(new URL(location, current).href);
      continue;
    }
    if (statusCode < 200 || statusCode >= 300 || !Buffer.isBuffer(response?.body)) {
      throw new Error(`External image request failed with HTTP ${statusCode || 'unknown'}`);
    }
    if (response.body.length > maxBytes) {
      throw new Error(`External image exceeds the ${maxBytes}-byte limit`);
    }
    return {
      buffer: response.body,
      finalUrl: current.href,
      contentType: singleHeaderValue(response.headers, 'content-type'),
    };
  }
}
