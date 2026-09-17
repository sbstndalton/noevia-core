'use strict';
// S3-compatible object store for offsite-backup.cjs (any provider speaking SigV4, path-style).
// Credentials come from env and are only ever sent in signed headers, never in URLs or logs.
const { signS3Request } = require('./s3-sign.cjs');

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function createS3Store({ endpoint, bucket, region = 'us-east-1', accessKeyId, secretAccessKey, prefix = 'noevia-backup', fetchImpl = fetch, timeoutMs = 60000 }) {
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw Object.assign(Error('Offsite backup needs endpoint, bucket and credentials.'), { status: 409 });
  const base = new URL(endpoint);
  if (base.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw Object.assign(Error('Offsite backup endpoints must use HTTPS.'), { status: 409 });
  if (base.username || base.password || base.search) throw Object.assign(Error('Put credentials in their own settings, not the endpoint URL.'), { status: 409 });
  const root = String(prefix).replace(/^\/+|\/+$/g, '');
  const url = (key, query) => {
    const u = new URL(`${base.origin}${base.pathname.replace(/\/+$/, '')}/${[bucket, ...`${root}/${key}`.split('/').filter(Boolean)].map(encodeURIComponent).join('/')}`);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, v);
    return u;
  };
  async function request(method, target, body = Buffer.alloc(0)) {
    const headers = signS3Request(method, target, body, accessKeyId, secretAccessKey, { region });
    delete headers.host;
    const response = await fetchImpl(target, { method, headers, body: method === 'PUT' ? body : undefined, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    return response;
  }
  return {
    async put(key, bytes) {
      const r = await request('PUT', url(key), bytes);
      if (!r.ok) throw Object.assign(Error(`The backup destination refused a write (${r.status}).`), { status: 502 });
    },
    async get(key) {
      const r = await request('GET', url(key));
      if (r.status === 404) return null;
      if (!r.ok) throw Object.assign(Error(`The backup destination refused a read (${r.status}).`), { status: 502 });
      return Buffer.from(await r.arrayBuffer());
    },
    async delete(key) {
      const r = await request('DELETE', url(key));
      if (!r.ok && r.status !== 404) throw Object.assign(Error(`The backup destination refused a delete (${r.status}).`), { status: 502 });
    },
    async list(keyPrefix) {
      const keys = [];
      let token;
      const full = `${root}/${keyPrefix}`;
      for (let page = 0; page < 1000; page++) {
        const target = new URL(`${base.origin}${base.pathname.replace(/\/+$/, '')}/${encodeURIComponent(bucket)}`);
        target.searchParams.set('list-type', '2'); target.searchParams.set('prefix', full);
        if (token) target.searchParams.set('continuation-token', token);
        const r = await request('GET', target);
        if (!r.ok) throw Object.assign(Error(`The backup destination refused a listing (${r.status}).`), { status: 502 });
        const xml = await r.text();
        for (const m of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) keys.push(decode(m[1]).slice(root.length + 1));
        const next = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/);
        if (!/<IsTruncated>true<\/IsTruncated>/.test(xml) || !next) break;
        token = decode(next[1]);
      }
      return keys;
    },
  };
}

module.exports = { createS3Store };
