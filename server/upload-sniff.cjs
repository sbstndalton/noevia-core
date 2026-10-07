'use strict';

// Upload checks (#977): validate (filename rule, 25 MB cap, archive refusal), classify and
// decodeText, moved here unchanged from uploads.cjs.

const path = require('node:path');
const storage = require('./storage-client.cjs');
const storagePath = require('./storage-path.cjs');

const CAP = 25 * 1024 * 1024;
function classifyJs(name) {
  const ext = path.extname(name).toLowerCase();
  if (/^\.(pdf|docx?|odt|rtf|pptx?|xlsx?|ods|odp|epub)$/.test(ext)) return 'Documents';
  if (/^\.(png|jpe?g|webp|gif|heic|heif|tiff?|bmp|svg|avif)$/.test(ext)) return 'Images';
  return storage.TEXT_EXTENSIONS.has(ext) ? 'Text' : 'Other';
}
function validateJs(name, bytes) {
  if (!storagePath.isPlainFilename(name)) throw Object.assign(new Error('Use a plain filename of at most 200 characters.'), { status: 400 });
  if (!bytes.length || bytes.length > CAP) throw Object.assign(new Error('Files must be non-empty and no larger than 25 MB.'), { status: bytes.length ? 413 : 400 });
  const ext = path.extname(name).toLowerCase();
  // Office/OpenDocument files are containers internally, but are documents, not archive bundles.
  const packagedDocument = /^\.(docx|xlsx|pptx|odt|ods|odp|epub)$/.test(ext);
  const archiveMagic = bytes.subarray(0, 4).equals(Buffer.from([0x50,0x4b,3,4])) || bytes.subarray(0,2).equals(Buffer.from([0x1f,0x8b])) || /^(Rar!|7z\xbc\xaf|BZh)/.test(bytes.subarray(0,6).toString('latin1')) || bytes.subarray(257,262).toString() === 'ustar';
  if (/\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst|cab|iso)$/i.test(name) || (archiveMagic && !packagedDocument)) throw Object.assign(new Error('Archive bundles are not supported. Upload their individual files instead.'), { status: 400 });
}
// A text file is not always UTF-8, and a `.txt` exported from an older editor
// very often is not. This used to be one fatal UTF-8 decode inside a bare
// `catch { state = 'stored' }`: a Latin-1 or UTF-16 file was silently reduced
// to empty content, indistinguishable from an opaque binary, with nothing told
// to the user and nothing logged. That is data loss, not a limitation.
//
// So: honour a BOM, then try UTF-8 strictly, then fall back to windows-1252 —
// which is the usual answer for legacy Western European text and, being a
// total mapping, cannot itself fail. Because it cannot fail, it would happily
// turn a JPEG into mojibake, so binary is ruled out first by the one signal
// that is reliable across encodings: a NUL byte, which no text encoding here
// produces for real content.
//
// Returns null only when the bytes are genuinely not text. A non-UTF-8 read is
// reported as such rather than presented as a clean read.
function decodeTextJs(bytes) {
  const decode = (encoding, from = 0) => new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(from));
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    try { return { text: decode('utf-8', 3), encoding: 'utf-8' }; } catch { /* a lying BOM; fall through */ }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    try { return { text: decode('utf-16le', 2), encoding: 'utf-16le' }; } catch { /* fall through */ }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    try { return { text: decode('utf-16be', 2), encoding: 'utf-16be' }; } catch { /* fall through */ }
  }
  // No BOM: a NUL byte means binary. NUL is valid UTF-8, so this must precede the UTF-8 attempt or a
  // file of NULs and ASCII would be read as "text" (#586).
  if (bytes.includes(0)) return null;
  try { return { text: decode('utf-8'), encoding: 'utf-8' }; } catch { /* not UTF-8; keep going */ }
  try { return { text: decode('windows-1252'), encoding: 'windows-1252' }; } catch { return null; }
}

const classify = classifyJs, validate = validateJs, decodeText = decodeTextJs;

module.exports = { CAP, classify, validate, decodeText, classifyJs, validateJs, decodeTextJs };
