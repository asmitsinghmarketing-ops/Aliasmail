import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(root, '.env') });

const env = (key, fallback = '') => process.env[key]?.trim() || fallback;
const databaseUrl = env('DATABASE_URL') || env('MYSQL_URL') || env('MYSQL_DATABASE_URL');
if (!databaseUrl || !/^mysql:/i.test(databaseUrl)) {
  throw new Error('Set DATABASE_URL (mysql://...) before running migrate:tenants');
}

const dataFile = path.resolve(root, env('DATA_FILE', 'data/db.json'));
const state = JSON.parse(await fs.readFile(dataFile, 'utf8'));
const now = new Date();
const organizationId = crypto.randomUUID();
const mailboxId = crypto.randomUUID();
const ownerId = crypto.randomUUID();
const slug = (env('TENANT_SLUG', state.owner?.displayName || 'legacy-organization')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)) || `org-${organizationId.slice(0, 8)}`;
const organizationName = env('TENANT_NAME', state.owner?.displayName || 'Legacy organization');
const mailbox = env('MAIL_USER').toLowerCase();
const ownerPasswordHash = env('ADMIN_PASSWORD') ? await bcrypt.hash(env('ADMIN_PASSWORD'), 12) : null;

const pool = mysql.createPool({ uri: databaseUrl, connectionLimit: 2 });
const connection = await pool.getConnection();
try {
  await connection.beginTransaction();
  const [existing] = await connection.query('SELECT id FROM ns_organizations WHERE slug = ? LIMIT 1', [slug]);
  if (existing.length) throw new Error(`Tenant slug "${slug}" already exists; migration is already complete or needs TENANT_SLUG`);

  await connection.query(
    'INSERT INTO ns_organizations (id, name, slug, status, created_at) VALUES (?, ?, ?, ?, ?)',
    [organizationId, organizationName, slug, 'active', now],
  );
  await connection.query(
    'INSERT INTO ns_mailboxes (id, organization_id, address, provider, settings_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [mailboxId, organizationId, mailbox, 'imap-smtp', JSON.stringify({}), now],
  );
  await connection.query(
    'INSERT INTO ns_users (id, organization_id, email, display_name, password_hash, role, active, mfa_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [ownerId, organizationId, mailbox, state.owner?.displayName || '', ownerPasswordHash, 'owner', 1, JSON.stringify(state.owner?.mfa || null), now],
  );

  for (const alias of state.aliases || []) {
    const userId = alias.type === 'group' ? null : crypto.randomUUID();
    if (userId) {
      await connection.query(
        'INSERT INTO ns_users (id, organization_id, email, display_name, password_hash, role, active, mfa_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [userId, organizationId, alias.address, alias.displayName || alias.ownerName || '', alias.passwordHash || null, 'user', alias.active === false ? 0 : 1, JSON.stringify(alias.mfa || null), alias.createdAt ? new Date(alias.createdAt) : now],
      );
    }
    await connection.query(
      'INSERT INTO ns_aliases (id, organization_id, mailbox_id, user_id, address, type, display_name, active, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [alias.id, organizationId, mailboxId, userId, alias.address, alias.type === 'group' ? 'group' : 'personal', alias.displayName || '', alias.active === false ? 0 : 1, JSON.stringify({ ownerName: alias.ownerName || '', color: alias.color || null }), alias.createdAt ? new Date(alias.createdAt) : now],
    );
  }
  await connection.commit();
  console.log(`Migrated ${state.aliases?.length || 0} aliases into organization ${organizationId} (${slug}).`);
} catch (error) {
  await connection.rollback();
  throw error;
} finally {
  connection.release();
  await pool.end();
}
