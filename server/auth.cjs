'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { hash, verify, Algorithm } = require('@node-rs/argon2');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;
const IDLE_MS = 7 * 24 * 60 * 60 * 1000;
const ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
const CHALLENGE_MS = 5 * 60 * 1000;

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}

function clientAddress(req) {
  return String(req.socket?.remoteAddress || 'unknown');
}

function createAuth({ dataDir, publicOrigin, rpId, legacyToken = '', legacyCompat = false, secrets = null }) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new Database(path.join(dataDir, 'cowork.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users(
      id TEXT PRIMARY KEY, username TEXT NOT NULL, username_norm TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member')),
      password_hash TEXT NOT NULL, webauthn_user_id TEXT NOT NULL UNIQUE,
      disabled_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions(
      id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, user_agent TEXT NOT NULL, ip TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS passkeys(
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, public_key BLOB NOT NULL, webauthn_user_id TEXT NOT NULL,
      counter INTEGER NOT NULL, device_type TEXT NOT NULL, backed_up INTEGER NOT NULL,
      transports TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS challenges(
      id_hash TEXT PRIMARY KEY, user_id TEXT, kind TEXT NOT NULL, challenge TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invitations(
      token_hash TEXT PRIMARY KEY, created_by TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recoveries(
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_by TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL,
      used_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor_user_id TEXT, target_user_id TEXT,
      action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS storage_connections(
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, base_url TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '',
      secret TEXT NOT NULL DEFAULT '', corpus_root TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_features(
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      diary_enabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, unixepoch() * 1000);
    INSERT OR IGNORE INTO user_features(user_id, diary_enabled, updated_at)
      SELECT id, 1, unixepoch() * 1000 FROM users;
    INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(2, unixepoch() * 1000);
  `);

  const configuredOrigin = db.prepare("SELECT value FROM settings WHERE key='public_origin'").get()?.value;
  let origin = publicOrigin || configuredOrigin || '';
  let relyingPartyId = rpId || (origin ? new URL(origin).hostname : 'localhost');
  const setupFile = path.join(dataDir, 'first-run-setup-code');

  function userCount() {
    return db.prepare('SELECT count(*) AS n FROM users').get().n;
  }

  if (userCount() === 0 && !fs.existsSync(setupFile)) {
    const code = randomToken(16);
    fs.writeFileSync(setupFile, `${code}\n`, { mode: 0o600, flag: 'wx' });
    db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('setup_code_hash',?)").run(digest(code));
    console.warn(`FIRST-RUN SETUP CODE: ${code}`);
    console.warn(`Setup code file: ${setupFile} (deleted after setup)`);
  }

  const rate = new Map();
  function rateLimited(key, limit = 5, windowMs = 15 * 60 * 1000) {
    const now = Date.now();
    const current = rate.get(key);
    if (!current || current.reset <= now) {
      rate.set(key, { count: 1, reset: now + windowMs });
      return false;
    }
    current.count += 1;
    return current.count > limit;
  }

  function publicUser(row) {
    if (!row) return null;
    const feature = db.prepare('SELECT diary_enabled FROM user_features WHERE user_id=?').get(row.id);
    return { id: row.id, username: row.username, displayName: row.display_name, role: row.role,
      disabled: !!row.disabled_at, diaryEnabled: !!feature?.diary_enabled };
  }

  function issueSession(req, res, user) {
    const raw = randomToken();
    const csrf = randomToken();
    const now = Date.now();
    db.prepare('INSERT INTO sessions(id_hash,user_id,csrf_hash,created_at,last_seen_at,expires_at,user_agent,ip) VALUES(?,?,?,?,?,?,?,?)')
      .run(digest(raw), user.id, digest(csrf), now, now, now + ABSOLUTE_MS, String(req.headers['user-agent'] || '').slice(0, 300), clientAddress(req));
    const secure = origin.startsWith('https://') ? '; Secure' : '';
    res.setHeader('Set-Cookie', [
      `cowork_session=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ABSOLUTE_MS / 1000}${secure}`,
      `cowork_csrf=${csrf}; Path=/; SameSite=Lax; Max-Age=${ABSOLUTE_MS / 1000}${secure}`,
    ]);
    return csrf;
  }

  function authenticate(req) {
    const raw = parseCookies(req).cowork_session;
    const now = Date.now();
    if (raw) {
      const row = db.prepare(`SELECT s.*,u.id AS id,u.username,u.display_name,u.role,u.disabled_at
        FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=?`).get(digest(raw));
      if (row && !row.disabled_at && row.expires_at > now && row.last_seen_at + IDLE_MS > now) {
        db.prepare('UPDATE sessions SET last_seen_at=? WHERE id_hash=?').run(now, row.id_hash);
        return { user: publicUser(row), session: row, legacy: false };
      }
      db.prepare('DELETE FROM sessions WHERE id_hash=?').run(digest(raw));
    }
    if (legacyCompat && legacyToken && userCount() > 0) {
      const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const a = Buffer.from(supplied); const b = Buffer.from(legacyToken);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        const admin = db.prepare("SELECT * FROM users WHERE role='admin' AND disabled_at IS NULL ORDER BY created_at LIMIT 1").get();
        if (admin) return { user: publicUser(admin), session: null, legacy: true };
      }
    }
    return null;
  }

  function csrfValid(req, authn) {
    if (!authn || authn.legacy) return !!authn;
    const value = String(req.headers['x-csrf-token'] || '');
    const cookie = parseCookies(req).cowork_csrf || '';
    return value && value === cookie && digest(value) === authn.session.csrf_hash;
  }

  function originValid(req) {
    if (!origin) return true;
    const supplied = String(req.headers.origin || '');
    return !supplied || supplied === origin;
  }

  async function createPasswordHash(password) {
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw new Error('password must be 12-128 characters');
    return hash(password, { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  }

  function saveChallenge(userId, kind, challenge) {
    const token = randomToken();
    db.prepare('INSERT INTO challenges(id_hash,user_id,kind,challenge,expires_at) VALUES(?,?,?,?,?)')
      .run(digest(token), userId || null, kind, challenge, Date.now() + CHALLENGE_MS);
    return token;
  }

  function takeChallenge(token, kind) {
    const row = db.prepare('SELECT * FROM challenges WHERE id_hash=? AND kind=? AND expires_at>?').get(digest(token), kind, Date.now());
    if (row) db.prepare('DELETE FROM challenges WHERE id_hash=?').run(row.id_hash);
    return row || null;
  }

  function audit(action, actor, target, detail = {}) {
    db.prepare('INSERT INTO audit_events(actor_user_id,target_user_id,action,detail,created_at) VALUES(?,?,?,?,?)')
      .run(actor || null, target || null, action, JSON.stringify(detail), Date.now());
  }

  return {
    db, get origin() { return origin; }, get rpId() { return relyingPartyId; }, userCount, authenticate, csrfValid, originValid, publicUser, issueSession,
    async setup(req, res, body) {
      if (userCount() !== 0) return { status: 409, body: { error: 'setup already complete' } };
      if (rateLimited(`setup:${clientAddress(req)}`)) return { status: 429, body: { error: 'try again later' } };
      const expected = db.prepare("SELECT value FROM settings WHERE key='setup_code_hash'").get()?.value;
      if (!expected || digest(body.setupCode || '') !== expected) return { status: 401, body: { error: 'setup could not be completed' } };
      if (!USERNAME_RE.test(String(body.username || ''))) return { status: 400, body: { error: 'invalid username' } };
      const selectedOrigin = String(body.publicOrigin || origin || '').replace(/\/$/, '');
      if (!/^https:\/\/[^/]+$/.test(selectedOrigin) && !/^http:\/\/localhost(?::\d+)?$/.test(selectedOrigin)) return { status: 400, body: { error: 'a secure public origin is required' } };
      let passwordHash;
      try { passwordHash = await createPasswordHash(body.password); } catch (e) { return { status: 400, body: { error: e.message } }; }
      const now = Date.now(); const id = crypto.randomUUID();
      origin = selectedOrigin;
      if (!rpId) relyingPartyId = new URL(selectedOrigin).hostname;
      const tx = db.transaction(() => {
        db.prepare('INSERT INTO users(id,username,username_norm,display_name,role,password_hash,webauthn_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(id, body.username, body.username.toLowerCase(), String(body.displayName || body.username).trim().slice(0, 80), 'admin', passwordHash, randomToken(32), now, now);
        db.prepare('INSERT INTO user_features(user_id,diary_enabled,updated_at) VALUES(?,?,?)')
          .run(id, body.diaryEnabled ? 1 : 0, now);
        db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('public_origin',?)").run(selectedOrigin);
        db.prepare("DELETE FROM settings WHERE key='setup_code_hash'").run();
      });
      tx();
      try { fs.unlinkSync(setupFile); } catch {}
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
      audit('setup.complete', id, id);
      return { status: 201, body: { user: publicUser(user), csrfToken: issueSession(req, res, user), migrationRequired: true } };
    },
    async passwordLogin(req, res, body) {
      const key = `login:${clientAddress(req)}:${String(body.username || '').toLowerCase()}`;
      if (rateLimited(key)) return { status: 429, body: { error: 'sign-in failed' } };
      const row = db.prepare('SELECT * FROM users WHERE username_norm=?').get(String(body.username || '').toLowerCase());
      const ok = row && !row.disabled_at ? await verify(row.password_hash, String(body.password || '')).catch(() => false) : false;
      if (!ok) return { status: 401, body: { error: 'sign-in failed' } };
      audit('auth.password', row.id, row.id);
      return { status: 200, body: { user: publicUser(row), csrfToken: issueSession(req, res, row) } };
    },
    logout(req, res, authn) {
      const raw = parseCookies(req).cowork_session;
      if (raw) db.prepare('DELETE FROM sessions WHERE id_hash=?').run(digest(raw));
      res.setHeader('Set-Cookie', [
        'cowork_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
        'cowork_csrf=; Path=/; SameSite=Lax; Max-Age=0',
      ]);
      return { status: 200, body: { ok: true } };
    },
    async registrationOptions(userId) {
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
      const keys = db.prepare('SELECT * FROM passkeys WHERE user_id=?').all(userId);
      const options = await generateRegistrationOptions({ rpName: 'Cowork', rpID: relyingPartyId, userName: user.username,
        userDisplayName: user.display_name, userID: Buffer.from(user.webauthn_user_id, 'base64url'), attestationType: 'none',
        excludeCredentials: keys.map(k => ({ id: k.id, transports: JSON.parse(k.transports) })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' } });
      return { options, challengeToken: saveChallenge(userId, 'register', options.challenge) };
    },
    async registrationVerify(userId, body) {
      const challenge = takeChallenge(body.challengeToken || '', 'register');
      if (!challenge || challenge.user_id !== userId) throw new Error('registration challenge expired');
      const verification = await verifyRegistrationResponse({ response: body.response, expectedChallenge: challenge.challenge,
        expectedOrigin: origin || db.prepare("SELECT value FROM settings WHERE key='public_origin'").get().value, expectedRPID: relyingPartyId,
        requireUserVerification: true });
      if (!verification.verified || !verification.registrationInfo) throw new Error('passkey registration failed');
      const info = verification.registrationInfo; const cred = info.credential;
      db.prepare('INSERT INTO passkeys(id,user_id,name,public_key,webauthn_user_id,counter,device_type,backed_up,transports,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(cred.id, userId, String(body.name || 'Passkey').slice(0, 80), Buffer.from(cred.publicKey), db.prepare('SELECT webauthn_user_id FROM users WHERE id=?').get(userId).webauthn_user_id,
          cred.counter, info.credentialDeviceType, info.credentialBackedUp ? 1 : 0, JSON.stringify(cred.transports || []), Date.now());
      audit('passkey.add', userId, userId, { credentialId: cred.id });
      return { verified: true };
    },
    async authenticationOptions(username) {
      const user = db.prepare('SELECT * FROM users WHERE username_norm=? AND disabled_at IS NULL').get(String(username || '').toLowerCase());
      const keys = user ? db.prepare('SELECT * FROM passkeys WHERE user_id=?').all(user.id) : [];
      const options = await generateAuthenticationOptions({ rpID: relyingPartyId, userVerification: 'required',
        allowCredentials: keys.map(k => ({ id: k.id, transports: JSON.parse(k.transports) })) });
      return { options, challengeToken: saveChallenge(user?.id || null, 'authenticate', options.challenge) };
    },
    async authenticationVerify(req, res, body) {
      const challenge = takeChallenge(body.challengeToken || '', 'authenticate');
      const key = db.prepare('SELECT * FROM passkeys WHERE id=?').get(body.response?.id || '');
      if (!challenge || !key || challenge.user_id !== key.user_id) throw new Error('authentication failed');
      const verification = await verifyAuthenticationResponse({ response: body.response, expectedChallenge: challenge.challenge,
        expectedOrigin: origin || db.prepare("SELECT value FROM settings WHERE key='public_origin'").get().value, expectedRPID: relyingPartyId,
        credential: { id: key.id, publicKey: new Uint8Array(key.public_key), counter: key.counter, transports: JSON.parse(key.transports) }, requireUserVerification: true });
      if (!verification.verified) throw new Error('authentication failed');
      db.prepare('UPDATE passkeys SET counter=?,last_used_at=? WHERE id=?').run(verification.authenticationInfo.newCounter, Date.now(), key.id);
      const user = db.prepare('SELECT * FROM users WHERE id=? AND disabled_at IS NULL').get(key.user_id);
      if (!user) throw new Error('authentication failed');
      audit('auth.passkey', user.id, user.id, { credentialId: key.id });
      return { user: publicUser(user), csrfToken: issueSession(req, res, user) };
    },
    listPasskeys(userId) {
      return db.prepare('SELECT id,name,device_type AS deviceType,backed_up AS backedUp,created_at AS createdAt,last_used_at AS lastUsedAt FROM passkeys WHERE user_id=? ORDER BY created_at').all(userId);
    },
    listSessions(userId) {
      return db.prepare('SELECT id_hash AS id,created_at AS createdAt,last_seen_at AS lastSeenAt,expires_at AS expiresAt,user_agent AS userAgent,ip FROM sessions WHERE user_id=? ORDER BY last_seen_at DESC').all(userId);
    },
    revokeSession(userId, id) { return db.prepare('DELETE FROM sessions WHERE id_hash=? AND user_id=?').run(id, userId).changes > 0; },
    deletePasskey(userId, id) { return db.prepare('DELETE FROM passkeys WHERE id=? AND user_id=?').run(id, userId).changes > 0; },
    renamePasskey(userId, id, name) { return db.prepare('UPDATE passkeys SET name=? WHERE id=? AND user_id=?').run(String(name).trim().slice(0,80), id, userId).changes > 0; },
    listUsers() { return db.prepare('SELECT * FROM users ORDER BY created_at').all().map(publicUser); },
    createInvite(adminId, role = 'member') {
      const token = randomToken(); const now = Date.now();
      db.prepare('INSERT INTO invitations(token_hash,created_by,role,expires_at,created_at) VALUES(?,?,?,?,?)').run(digest(token), adminId, role === 'admin' ? 'admin' : 'member', now + 86400000, now);
      audit('invite.create', adminId, null, { role }); return { token, expiresAt: now + 86400000 };
    },
    async acceptInvite(req, res, body) {
      const invite = db.prepare('SELECT * FROM invitations WHERE token_hash=? AND used_at IS NULL AND expires_at>?').get(digest(body.token || ''), Date.now());
      if (!invite) return { status: 400, body: { error: 'invitation is invalid or expired' } };
      if (!USERNAME_RE.test(String(body.username || ''))) return { status: 400, body: { error: 'invalid username' } };
      let passwordHash; try { passwordHash = await createPasswordHash(body.password); } catch (e) { return { status: 400, body: { error: e.message } }; }
      const id = crypto.randomUUID(); const now = Date.now();
      try {
        db.transaction(() => {
          db.prepare('INSERT INTO users(id,username,username_norm,display_name,role,password_hash,webauthn_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
            .run(id, body.username, body.username.toLowerCase(), String(body.displayName || body.username).slice(0,80), invite.role, passwordHash, randomToken(32), now, now);
          db.prepare('INSERT INTO user_features(user_id,diary_enabled,updated_at) VALUES(?,?,?)')
            .run(id, body.diaryEnabled ? 1 : 0, now);
          db.prepare('UPDATE invitations SET used_at=? WHERE token_hash=?').run(now, invite.token_hash);
        })();
      } catch { return { status: 409, body: { error: 'username is unavailable' } }; }
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(id); audit('invite.accept', id, id);
      return { status: 201, body: { user: publicUser(user), csrfToken: issueSession(req, res, user) } };
    },
    setDisabled(actorId, userId, disabled) {
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId); if (!user) return false;
      if (user.role === 'admin' && disabled && db.prepare("SELECT count(*) AS n FROM users WHERE role='admin' AND disabled_at IS NULL").get().n <= 1) throw new Error('cannot disable the last administrator');
      db.prepare('UPDATE users SET disabled_at=?,updated_at=? WHERE id=?').run(disabled ? Date.now() : null, Date.now(), userId);
      if (disabled) db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
      audit(disabled ? 'user.disable' : 'user.enable', actorId, userId); return true;
    },
    createRecovery(actorId, userId) {
      if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) return null;
      const token = randomToken(); const now = Date.now();
      db.prepare('INSERT INTO recoveries(token_hash,user_id,created_by,expires_at,created_at) VALUES(?,?,?,?,?)').run(digest(token), userId, actorId, now + 3600000, now);
      audit('recovery.create', actorId, userId); return { token, expiresAt: now + 3600000 };
    },
    async completeRecovery(body) {
      const row = db.prepare('SELECT * FROM recoveries WHERE token_hash=? AND used_at IS NULL AND expires_at>?').get(digest(body.token || ''), Date.now());
      if (!row) return false; const passwordHash = await createPasswordHash(body.password);
      db.transaction(() => { db.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').run(passwordHash, Date.now(), row.user_id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(row.user_id); db.prepare('UPDATE recoveries SET used_at=? WHERE token_hash=?').run(Date.now(), row.token_hash); })();
      audit('recovery.complete', row.user_id, row.user_id); return true;
    },
    updateProfile(userId, displayName) { db.prepare('UPDATE users SET display_name=?,updated_at=? WHERE id=?').run(String(displayName).trim().slice(0,80), Date.now(), userId); },
    diaryEnabled(userId) {
      return !!db.prepare('SELECT diary_enabled FROM user_features WHERE user_id=?').get(userId)?.diary_enabled;
    },
    setDiaryEnabled(userId, enabled) {
      db.prepare(`INSERT INTO user_features(user_id,diary_enabled,updated_at) VALUES(?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET diary_enabled=excluded.diary_enabled,updated_at=excluded.updated_at`)
        .run(userId, enabled ? 1 : 0, Date.now());
      audit('feature.diary', userId, userId, { enabled: !!enabled });
      return { diaryEnabled: !!enabled };
    },
    deleteUser(actorId, userId, username) {
      const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId); if (!user || user.username !== username) return false;
      if (user.role === 'admin' && db.prepare("SELECT count(*) AS n FROM users WHERE role='admin'").get().n <= 1) throw new Error('cannot delete the last administrator');
      db.prepare('DELETE FROM users WHERE id=?').run(userId); audit('user.delete', actorId, userId); return true;
    },
    getStorage(userId, includeSecret = false) {
      const row = db.prepare('SELECT * FROM storage_connections WHERE user_id=?').get(userId);
      if (!row) return { kind: 'local', baseUrl: '', username: '', corpusRoot: '' };
      const plain = secrets ? secrets.decrypt(row.secret) : row.secret;
      return { kind: row.kind, baseUrl: row.base_url, username: row.username, corpusRoot: row.corpus_root,
        secret: includeSecret ? plain : undefined, secretConfigured: !!plain };
    },
    saveStorage(userId, value) {
      const kind = ['local', 'nextcloud', 'webdav'].includes(value.kind) ? value.kind : 'local';
      const encrypted = secrets ? secrets.encrypt(value.secret || '') : (value.secret || '');
      db.prepare(`INSERT INTO storage_connections(user_id,kind,base_url,username,secret,corpus_root,updated_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET kind=excluded.kind,base_url=excluded.base_url,
        username=excluded.username,secret=excluded.secret,corpus_root=excluded.corpus_root,updated_at=excluded.updated_at`)
        .run(userId, kind, String(value.baseUrl || '').replace(/\/+$/, ''), String(value.username || ''), encrypted, String(value.corpusRoot || ''), Date.now());
      audit('storage.update', userId, userId, { kind });
      return this.getStorage(userId);
    },
  };
}

module.exports = { createAuth, USERNAME_RE, digest };
