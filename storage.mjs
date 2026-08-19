import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function fromRow(row) {
  if (!row) return null;
  return {
    token: row.token,
    recipient: row.recipient,
    note: row.note,
    group: row.group_name,
    expires: row.expires,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    openedAt: row.opened_at ? new Date(row.opened_at).toISOString() : null,
    capturedAt: row.captured_at ? new Date(row.captured_at).toISOString() : null,
    status: row.status,
    photoFilename: row.photo_path,
    photoContentType: row.photo_content_type,
    photoSize: row.photo_size == null ? null : Number(row.photo_size),
    telegram: {
      status: row.telegram_status || 'not_configured',
      sentAt: row.telegram_sent_at ? new Date(row.telegram_sent_at).toISOString() : null,
      messageId: row.telegram_message_id == null ? null : Number(row.telegram_message_id),
      error: row.telegram_error || null
    }
  };
}

async function createVercelStorage() {
  const [{ neon }, blob] = await Promise.all([
    import('@neondatabase/serverless'),
    import('@vercel/blob')
  ]);
  const sql = neon(process.env.DATABASE_URL);
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;

  await sql`
    CREATE TABLE IF NOT EXISTS camera_links (
      token text PRIMARY KEY,
      recipient text NOT NULL,
      note text NOT NULL DEFAULT '',
      group_name text NOT NULL,
      expires text NOT NULL,
      created_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      opened_at timestamptz,
      captured_at timestamptz,
      status text NOT NULL,
      photo_path text,
      photo_content_type text,
      photo_size bigint,
      telegram_status text,
      telegram_sent_at timestamptz,
      telegram_message_id bigint,
      telegram_error text
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS camera_links_created_at_idx ON camera_links (created_at DESC)`;

  return {
    mode: 'vercel',
    async listLinks() {
      return (await sql`SELECT * FROM camera_links ORDER BY created_at DESC`).map(fromRow);
    },
    async getLink(token) {
      const rows = await sql`SELECT * FROM camera_links WHERE token = ${token} LIMIT 1`;
      return fromRow(rows[0]);
    },
    async createLink(link) {
      const rows = await sql`
        INSERT INTO camera_links (token, recipient, note, group_name, expires, created_at, expires_at, status)
        VALUES (${link.token}, ${link.recipient}, ${link.note}, ${link.group}, ${link.expires}, ${link.createdAt}, ${link.expiresAt}, ${link.status})
        RETURNING *
      `;
      return fromRow(rows[0]);
    },
    async updateLink(link) {
      const telegram = link.telegram || {};
      const rows = await sql`
        UPDATE camera_links SET
          recipient = ${link.recipient}, note = ${link.note}, group_name = ${link.group}, expires = ${link.expires},
          created_at = ${link.createdAt}, expires_at = ${link.expiresAt}, opened_at = ${link.openedAt || null},
          captured_at = ${link.capturedAt || null}, status = ${link.status}, photo_path = ${link.photoFilename || null},
          photo_content_type = ${link.photoContentType || null}, photo_size = ${link.photoSize || null},
          telegram_status = ${telegram.status || null}, telegram_sent_at = ${telegram.sentAt || null},
          telegram_message_id = ${telegram.messageId || null}, telegram_error = ${telegram.error || null}
        WHERE token = ${link.token}
        RETURNING *
      `;
      return fromRow(rows[0]);
    },
    async clearLinks() {
      const rows = await sql`DELETE FROM camera_links RETURNING photo_path`;
      const paths = rows.map((row) => row.photo_path && `photos/${row.photo_path}`).filter(Boolean);
      if (paths.length) await blob.del(paths, { token: blobToken });
    },
    async savePhoto(path, body, contentType) {
      await blob.put(`photos/${path}`, body, {
        access: 'private', token: blobToken, contentType,
        addRandomSuffix: false, allowOverwrite: false
      });
    },
    async readPhoto(path) {
      const result = await blob.get(`photos/${path}`, { access: 'private', token: blobToken });
      if (!result || result.statusCode !== 200 || !result.stream) return null;
      return Buffer.from(await new Response(result.stream).arrayBuffer());
    },
    async deletePhoto(path) {
      if (path) await blob.del(`photos/${path}`, { token: blobToken });
    }
  };
}

async function createLocalStorage(dataRoot) {
  const photosRoot = join(dataRoot, 'photos');
  const databasePath = join(dataRoot, 'db.json');
  await mkdir(photosRoot, { recursive: true });

  let database;
  try {
    database = JSON.parse(await readFile(databasePath, 'utf8'));
    if (!Array.isArray(database.links)) throw new Error('Invalid database');
  } catch {
    database = { links: [] };
    await writeFile(databasePath, JSON.stringify(database, null, 2), 'utf8');
  }

  let saveQueue = Promise.resolve();
  function save() {
    const snapshot = JSON.stringify(database, null, 2);
    saveQueue = saveQueue.then(() => writeFile(databasePath, snapshot, 'utf8'));
    return saveQueue;
  }

  return {
    mode: 'local',
    async listLinks() { return database.links; },
    async getLink(token) { return database.links.find((item) => item.token === token) || null; },
    async createLink(link) {
      database.links.unshift(link);
      await save();
      return link;
    },
    async updateLink(link) {
      const index = database.links.findIndex((item) => item.token === link.token);
      if (index >= 0) database.links[index] = link;
      await save();
      return link;
    },
    async clearLinks() {
      const paths = database.links.map((link) => link.photoFilename).filter(Boolean);
      database.links = [];
      await save();
      await Promise.all(paths.map((path) => unlink(join(photosRoot, path)).catch(() => {})));
    },
    async savePhoto(path, body) { await writeFile(join(photosRoot, path), body, { flag: 'wx' }); },
    async readPhoto(path) { return readFile(join(photosRoot, path)); },
    async deletePhoto(path) { if (path) await unlink(join(photosRoot, path)).catch(() => {}); }
  };
}

function createMemoryStorage() {
  const links = [];
  return {
    mode: 'setup',
    async listLinks() { return links; },
    async getLink(token) { return links.find((item) => item.token === token) || null; },
    async createLink(link) { links.unshift(link); return link; },
    async updateLink(link) {
      const index = links.findIndex((item) => item.token === link.token);
      if (index >= 0) links[index] = link;
      return link;
    },
    async clearLinks() { links.length = 0; },
    async savePhoto() { throw new Error('Blob-хранилище ещё не подключено'); },
    async readPhoto() { return null; },
    async deletePhoto() {}
  };
}

export async function createStorage(dataRoot) {
  const hasDatabase = Boolean(process.env.DATABASE_URL);
  const hasBlob = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
  if (hasDatabase !== hasBlob) throw new Error('DATABASE_URL и BLOB_READ_WRITE_TOKEN должны быть заданы вместе');
  if (hasDatabase) return createVercelStorage();
  if (process.env.VERCEL) return createMemoryStorage();
  return createLocalStorage(dataRoot);
}
