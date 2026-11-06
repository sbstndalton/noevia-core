'use strict';
// Row V fix round 3: what the RETIRED Node issuer left on disk, written by the real (frozen) Node code.
// Node kept no private issuer state: the key is HMAC(master, random nonce), the nonce was never stored and
// the session was in memory, so the published key file (CODE_EGRESS_CONTROL_KEY_FILE) is the only durable
// artifact. The native issuer (noevia-rs crates/egress-issuer) takes that key over once, unchanged, when it
// finds it owned by the web user in a trusted directory. This generator runs publishWebKey from the frozen
// oracle in a synthetic temp directory with a fixed master and nonce and records the bytes and the metadata
// the takeover checks. Deterministic; synthetic data only; no key here protects anything.
//
// usage: node tests/reference/code-egress-legacy-publication.cjs [<out.json>]
//        node tests/reference/code-egress-legacy-publication.cjs --dir <existing-0750-dir>   (publish there, print the json)
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');

const MASTER = Buffer.alloc(32, 7), NONCE = Buffer.alloc(32, 0x5a);
const realRandomBytes = crypto.randomBytes.bind(crypto);
// The nonce (32 bytes) is the one random input of the web key; the 16-byte draw is the temporary file name.
function withFixedNonce(run) {
  crypto.randomBytes = (n, cb) => (cb ? realRandomBytes(n, cb) : n === 32 ? Buffer.from(NONCE) : n === 16 ? Buffer.alloc(16, 0x11) : realRandomBytes(n));
  try { return run(); } finally { crypto.randomBytes = realRandomBytes; }
}

/** Publishes the web key the way Node's start did, into `dir` (a 0750 directory of this uid/gid), and describes it. */
function publishInto(dir) {
  const { publishWebKey } = require('./code-egress-control.cjs');
  const uid = process.getuid(), gid = process.getgid();
  const file = path.join(dir, 'current.key');
  const key = withFixedNonce(() => publishWebKey({ masterKey: MASTER, file, uid, gid }));
  const st = fs.lstatSync(file), bytes = fs.readFileSync(file);
  return { file, key, doc: {
    version: 1, masterHex: MASTER.toString('hex'), nonceHex: NONCE.toString('hex'), keyHex: key.toString('hex'),
    fileHex: bytes.toString('hex'), fileMode: (st.mode & 0o7777).toString(8), nlink: st.nlink, isFile: st.isFile(),
    dirMode: (fs.lstatSync(dir).mode & 0o7777).toString(8),
  } };
}

function prepareDir(root) {
  const dir = path.join(root, 'egress-control');
  fs.mkdirSync(dir); fs.chownSync(dir, process.getuid(), process.getgid()); fs.chmodSync(dir, 0o750);
  return dir;
}

function generate() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'egress-legacy-')));
  try { return publishInto(prepareDir(root)).doc; } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

module.exports = { MASTER, NONCE, publishInto, prepareDir, generate };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--dir') { process.stdout.write(`${JSON.stringify(publishInto(args[1]).doc, null, 2)}\n`); }
  else {
    const text = `${JSON.stringify(generate(), null, 2)}\n`;
    if (args[0]) fs.writeFileSync(args[0], text); else process.stdout.write(text);
  }
}
