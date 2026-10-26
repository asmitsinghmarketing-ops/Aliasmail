// Where data is kept. With DATABASE_URL set (mysql://… or postgres://…) everything goes into the
// database, so it survives redeploys on hosts that rebuild the app from git. Without it, a JSON
// file and an avatars folder beside it (handy for running locally).
//
// The store is a handful of rows: app_state holds one JSON document per top-level key of the data
// (aliases, sessions, inbox cache, …) and app_files holds uploaded files such as profile pictures.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import config from './config.js';

const FILES_DIR = path.join(path.dirname(config.dataFile), 'avatars');
const CACHE_ID = /^[0-9a-f]{64}$/;

export function createFileBackend(dataFile = config.dataFile) {
  const FILES_DIR = path.join(path.dirname(dataFile), 'avatars');
  const MESSAGES_DIR = path.join(path.dirname(dataFile), 'mail-cache');
  const messagePath = (id) => {
    if (!CACHE_ID.test(id)) throw new Error('Invalid message cache ID');
    return path.join(MESSAGES_DIR, id);
  };
  return {
    kind: 'file',
    async init() {},
    async readState() {
      try {
        return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },
    // The file is always rewritten whole; `all` is the complete data.
    async writeState(changed, all) {
      fs.mkdirSync(path.dirname(dataFile), { recursive: true });
      const tmp = `${dataFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(all));
      fs.renameSync(tmp, dataFile);
    },
    async getMessage(id, limits) {
      const file = messagePath(id);
      try {
        const stat = await fs.promises.stat(file);
        if (limits && Date.now() - stat.mtimeMs > limits.maxAgeMs) {
          await this.deleteMessage(id);
          return null;
        }
        const data = await fs.promises.readFile(file);
        const now = new Date();
        await fs.promises.utimes(file, now, now);
        return data;
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    async putMessage(id, data) {
      await fs.promises.mkdir(MESSAGES_DIR, { recursive: true });
      const file = messagePath(id);
      const tmp = file + '.' + crypto.randomUUID() + '.tmp';
      try {
        await fs.promises.writeFile(tmp, data, { mode: 0o600 });
        await fs.promises.rename(tmp, file);
      } finally { await fs.promises.rm(tmp, { force: true }); }
    },
    async deleteMessage(id) { await fs.promises.rm(messagePath(id), { force: true }); },
    async pruneMessages({ maxBytes, maxAgeMs }) {
      const names = await fs.promises.readdir(MESSAGES_DIR).catch((error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      const entries = (await Promise.all(names.filter((id) => CACHE_ID.test(id)).map(async (id) => {
        try { const stat = await fs.promises.stat(messagePath(id)); return { id, size: stat.size, touched: stat.mtimeMs }; }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      }))).filter(Boolean).sort((a, b) => b.touched - a.touched);
      let used = 0;
      for (const entry of entries) {
        if (Date.now() - entry.touched > maxAgeMs || used + entry.size > maxBytes) await this.deleteMessage(entry.id);
        else used += entry.size;
      }
    },
    async getFile(id) {
      try {
        return { data: fs.readFileSync(path.join(FILES_DIR, id)) };
      } catch {
        return null;
      }
    },
    async putFile(id, type, data) {
      fs.mkdirSync(FILES_DIR, { recursive: true });
      fs.writeFileSync(path.join(FILES_DIR, id), data);
    },
    async deleteFile(id) {
      fs.rmSync(path.join(FILES_DIR, id), { force: true });
    },
  };
}

// MySQL and PostgreSQL differ only in placeholders, column types and the upsert clause.
async function sqlBackend(url) {
  const postgres = /^postgres(ql)?:/i.test(url);
  const ssl = config.databaseSsl ? { rejectUnauthorized: false } : undefined;
  let query;
  if (postgres) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url, ssl, max: 4 });
    query = async (sql, params = []) => {
      let n = 0;
      return (await pool.query(sql.replace(/\?/g, () => `$${++n}`), params)).rows;
    };
  } else {
    const mysql = await import('mysql2/promise');
    const pool = mysql.createPool({ uri: url, ssl, connectionLimit: 4 });
    query = async (sql, params = []) => (await pool.query(sql, params))[0];
  }
  const upsert = (table, key, cols) =>
    postgres
      ? `ON CONFLICT (${key}) DO UPDATE SET ${cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`
      : `ON DUPLICATE KEY UPDATE ${cols.map((c) => `${c} = VALUES(${c})`).join(', ')}`;

  return {
    kind: postgres ? 'postgres' : 'mysql',
    async init() {
      await query(`CREATE TABLE IF NOT EXISTS app_mail_cache (id VARCHAR(64) PRIMARY KEY, touched BIGINT NOT NULL, data ${postgres ? 'BYTEA' : 'LONGBLOB'} NOT NULL)`);
      await query(`CREATE TABLE IF NOT EXISTS app_state (k VARCHAR(64) PRIMARY KEY, v ${postgres ? 'TEXT' : 'LONGTEXT'} NOT NULL)`);
      await query(
        `CREATE TABLE IF NOT EXISTS app_files (id VARCHAR(64) PRIMARY KEY, type VARCHAR(100) NOT NULL, data ${postgres ? 'BYTEA' : 'LONGBLOB'} NOT NULL)`,
      );
    },
    async readState() {
      const rows = await query('SELECT k, v FROM app_state');
      if (!rows.length) return null;
      return Object.fromEntries(rows.map((r) => [r.k, JSON.parse(r.v)]));
    },
    // Only the keys whose JSON changed since the last write: [[key, json], …]
    async writeState(changed) {
      for (const [k, v] of changed) {
        await query(`INSERT INTO app_state (k, v) VALUES (?, ?) ${upsert('app_state', 'k', ['v'])}`, [k, v]);
      }
    },
    async getMessage(id, limits) {
      const [row] = await query('SELECT data, touched FROM app_mail_cache WHERE id = ?', [id]);
      if (!row) return null;
      if (limits && Date.now() - Number(row.touched) > limits.maxAgeMs) {
        await this.deleteMessage(id);
        return null;
      }
      await query('UPDATE app_mail_cache SET touched = ? WHERE id = ?', [Date.now(), id]);
      return Buffer.from(row.data);
    },
    async putMessage(id, data) {
      await query(`INSERT INTO app_mail_cache (id, touched, data) VALUES (?, ?, ?) ${upsert('app_mail_cache', 'id', ['touched', 'data'])}`, [id, Date.now(), data]);
    },
    async deleteMessage(id) { await query('DELETE FROM app_mail_cache WHERE id = ?', [id]); },
    async pruneMessages({ maxBytes, maxAgeMs }) {
      const entries = await query('SELECT id, touched, OCTET_LENGTH(data) AS size FROM app_mail_cache ORDER BY touched DESC');
      let used = 0;
      for (const entry of entries) {
        const size = Number(entry.size);
        if (Date.now() - Number(entry.touched) > maxAgeMs || used + size > maxBytes) await this.deleteMessage(entry.id);
        else used += size;
      }
    },
    async getFile(id) {
      const [row] = await query('SELECT type, data FROM app_files WHERE id = ?', [id]);
      return row ? { type: row.type, data: Buffer.from(row.data) } : null;
    },
    async putFile(id, type, data) {
      await query(`INSERT INTO app_files (id, type, data) VALUES (?, ?, ?) ${upsert('app_files', 'id', ['type', 'data'])}`, [id, type, data]);
    },
    async deleteFile(id) {
      await query('DELETE FROM app_files WHERE id = ?', [id]);
    },
  };
}

let backend = createFileBackend();

/** Pick the backend. The first time a database is used, copy in the local data file and avatars. */
export async function initPersistence() {
  if (!config.databaseUrl) return backend;
  const local = backend;
  backend = await sqlBackend(config.databaseUrl);
  await backend.init();
  if (!(await backend.readState())) {
    const stored = await local.readState();
    if (stored) {
      await backend.writeState(Object.entries(stored).map(([k, v]) => [k, JSON.stringify(v)]));
      for (const id of fs.existsSync(FILES_DIR) ? fs.readdirSync(FILES_DIR) : []) {
        const type = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[id.split('.').pop()] || 'application/octet-stream';
        await backend.putFile(id, type, (await local.getFile(id)).data);
      }
      console.log(`[store] copied ${config.dataFile} into the ${backend.kind} database`);
    }
  }
  console.log(`[store] using the ${backend.kind} database`);
  return backend;
}

export const persistence = () => backend;
