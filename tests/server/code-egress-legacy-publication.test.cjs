'use strict';
// Row V fix round 3: the published key the retired Node issuer left behind is the only state the native
// issuer takes over (noevia-rs crates/egress-issuer, tests/fixtures/node-published-key.json is a copy of the
// fixture below). These tests pin what Node wrote, and that Node can take the same files back (rollback)
// after the native issuer adopted them and kept its own state beside them.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const gen = require('../reference/code-egress-legacy-publication.cjs');
const { createKeyKeeper, publishWebKey, deriveFileKey } = require('../reference/code-egress-control.cjs');
const FIXTURE = path.join(__dirname, '..', 'reference', 'code-egress-legacy-publication.fixture.json');

const synthetic = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'egress-legacy-test-')));

test('the committed fixture is exactly what the real Node publisher writes (deterministic, 0440, one link, 64 hex + LF)', () => {
  const doc = gen.generate();
  assert.deepEqual(doc, JSON.parse(fs.readFileSync(FIXTURE, 'utf8')));
  assert.deepEqual(gen.generate(), doc);
  assert.equal(doc.fileMode, '440'); assert.equal(doc.dirMode, '750'); assert.equal(doc.nlink, 1); assert.equal(doc.isFile, true);
  assert.equal(doc.fileHex, Buffer.from(`${doc.keyHex}\n`).toString('hex'));
  assert.match(doc.keyHex, /^[0-9a-f]{64}$/);
  assert.equal(doc.keyHex, deriveFileKey(Buffer.from(doc.masterHex, 'hex'), Buffer.from(doc.nonceHex, 'hex')).toString('hex'));
});

test('Node keeps no private issuer state: publishing writes the key file and nothing else beside it', () => {
  const root = synthetic();
  try {
    const dir = gen.prepareDir(root);
    gen.publishInto(dir);
    assert.deepEqual(fs.readdirSync(dir), ['current.key']);
    assert.deepEqual(fs.readdirSync(root), ['egress-control']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('rollback to Node after the native issuer adopted the key: its own state beside the key changes nothing for Node', () => {
  const root = synthetic();
  try {
    const dir = gen.prepareDir(root);
    const { file, key } = gen.publishInto(dir);
    const before = fs.lstatSync(file), bytes = fs.readFileSync(file);
    // What the native issuer leaves after adopting: a 0700 directory of its own with a 0600 state file.
    const state = path.join(dir, 'issuer'); fs.mkdirSync(state, { mode: 0o700 });
    fs.writeFileSync(path.join(state, 'code-egress-issuer.json'), JSON.stringify({ version: 1, key: key.toString('hex'), next: null, epoch: null }), { mode: 0o600 });
    // Node's keeper recognises the adopted file as its own key (nothing was rewritten)...
    const uid = process.getuid(), gid = fs.lstatSync(dir).gid;
    const keeper = createKeyKeeper({ deriveMaster: () => gen.MASTER, fileKey: key, file, uid, gid });
    assert.equal(keeper.restore(), 'present');
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(fs.lstatSync(file).ino, before.ino);
    // ...and a rolled-back Node start publishes its own key over it exactly as it always did.
    const rolled = publishWebKey({ masterKey: gen.MASTER, file, uid, gid });
    assert.notEqual(rolled.toString('hex'), key.toString('hex'));
    assert.equal(fs.readFileSync(file, 'utf8'), `${rolled.toString('hex')}\n`);
    assert.equal(fs.lstatSync(file).mode & 0o7777, 0o440); assert.equal(fs.lstatSync(file).nlink, 1);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['current.key', 'issuer'], 'no temporary names left; the native state directory is not Node\'s business');
    assert.equal(fs.readFileSync(path.join(state, 'code-egress-issuer.json'), 'utf8').includes(key.toString('hex')), true, 'Node did not touch it');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
