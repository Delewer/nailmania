import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  assertPublicNetworkAddress,
  fetchPublicImage,
  readBoundedResponseBody,
  resolvePublicHost,
  sniffSupportedImage,
} from '../scripts/safe-external-image-fetch.mjs';

test('image sniffer accepts AVIF and AVIS ISO BMFF major brands', () => {
  for (const brand of ['avif', 'avis']) {
    const bytes = Buffer.alloc(24);
    bytes.writeUInt32BE(24, 0);
    bytes.write('ftyp', 4, 'latin1');
    bytes.write(brand, 8, 'latin1');
    assert.deepEqual(sniffSupportedImage(bytes), {
      ext: 'avif',
      contentType: 'image/avif',
    });
  }
  const otherBrand = Buffer.from('\x00\x00\x00\x18ftypmp42rest', 'latin1');
  assert.equal(sniffSupportedImage(otherBrand), null);
});

test('external image network guard rejects literal private, loopback, link-local, unspecified and multicast IPs', () => {
  for (const address of [
    '0.0.0.0',
    '10.1.2.3',
    '127.0.0.1',
    '169.254.10.20',
    '172.16.0.1',
    '192.168.1.1',
    '224.0.0.1',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
  ]) {
    assert.throws(() => assertPublicNetworkAddress(address), /blocked/);
  }
  assert.deepEqual(assertPublicNetworkAddress('8.8.8.8'), {
    address: '8.8.8.8',
    family: 4,
  });
  assert.deepEqual(assertPublicNetworkAddress('2606:4700:4700::1111'), {
    address: '2606:4700:4700::1111',
    family: 6,
  });
});

test('a literal loopback URL is rejected before the HTTP requester is called', async () => {
  let requests = 0;
  await assert.rejects(
    fetchPublicImage('http://127.0.0.1/private.jpg', {
      requester: async () => {
        requests++;
        throw new Error('must not be called');
      },
    }),
    /blocked ipv4/,
  );
  assert.equal(requests, 0);
});

test('DNS resolution fails closed if any resolved address is non-public', async () => {
  await assert.rejects(
    resolvePublicHost('mixed.example', {
      lookup: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
    }),
    /blocked ipv4/,
  );
  await assert.rejects(
    resolvePublicHost('empty.example', { lookup: async () => [] }),
    /no addresses/,
  );
});

test('manual redirects are re-resolved and blocked before a private redirect target is requested', async () => {
  const requested = [];
  const lookup = async (hostname) => (
    hostname === 'public.example'
      ? [{ address: '8.8.8.8', family: 4 }]
      : [{ address: '127.0.0.1', family: 4 }]
  );
  const requester = async ({ url }) => {
    requested.push(url);
    return {
      statusCode: 302,
      headers: { location: 'http://internal.example/secret.jpg' },
      body: null,
    };
  };

  await assert.rejects(
    fetchPublicImage('https://public.example/photo.jpg', { lookup, requester }),
    /blocked ipv4/,
  );
  assert.deepEqual(requested, ['https://public.example/photo.jpg']);
});

test('manual redirect count and redirect loops fail closed', async () => {
  const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
  const requester = async ({ url }) => ({
    statusCode: 302,
    headers: { location: `${url}?next=1` },
    body: null,
  });
  await assert.rejects(
    fetchPublicImage('https://public.example/photo.jpg', {
      lookup,
      requester,
      maxRedirects: 1,
    }),
    /exceeded 1 redirects/,
  );

  const loopRequester = async () => ({
    statusCode: 302,
    headers: { location: '/photo.jpg' },
    body: null,
  });
  await assert.rejects(
    fetchPublicImage('https://public.example/photo.jpg', {
      lookup,
      requester: loopRequester,
    }),
    /redirect loop/,
  );
});

test('Content-Length and streaming byte caps are both enforced', async () => {
  const declaredTooLarge = Readable.from([Buffer.from('small')]);
  declaredTooLarge.headers = { 'content-length': '101' };
  await assert.rejects(
    readBoundedResponseBody(declaredTooLarge, { maxBytes: 100 }),
    /100-byte limit/,
  );

  const streamedTooLarge = Readable.from([
    Buffer.alloc(60),
    Buffer.alloc(41),
  ]);
  streamedTooLarge.headers = {};
  await assert.rejects(
    readBoundedResponseBody(streamedTooLarge, { maxBytes: 100 }),
    /100-byte streaming limit/,
  );
});

test('a public, bounded response can complete after a verified public redirect', async () => {
  const lookups = [];
  const requests = [];
  const lookup = async (hostname) => {
    lookups.push(hostname);
    return [{ address: '8.8.8.8', family: 4 }];
  };
  const requester = async ({ url }) => {
    requests.push(url);
    if (url === 'https://public.example/start') {
      return {
        statusCode: 301,
        headers: { location: 'https://cdn.example/image.webp' },
        body: null,
      };
    }
    return {
      statusCode: 200,
      headers: { 'content-type': 'image/webp', 'content-length': '4' },
      body: Buffer.from('RIFF'),
    };
  };

  const result = await fetchPublicImage('https://public.example/start', {
    lookup,
    requester,
    maxBytes: 10,
  });
  assert.equal(result.finalUrl, 'https://cdn.example/image.webp');
  assert.deepEqual(result.buffer, Buffer.from('RIFF'));
  assert.deepEqual(lookups, ['public.example', 'cdn.example']);
  assert.deepEqual(requests, [
    'https://public.example/start',
    'https://cdn.example/image.webp',
  ]);
});
