const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { DEFAULT_USERS } = require('./default_users');

function parseBoolean(value, defaultValue = false) {
  if (value == null) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function normaliseUserRow(row) {
  if (!row) return null;
  return {
    id: row.user_id,
    userId: row.user_id,
    displayName: row.display_name || row.user_id,
    avatar: row.avatar || '',
    label: row.display_name || row.user_id,
  };
}

function normaliseSessionRow(row) {
  if (!row) return null;
  return {
    id: row.session_id,
    sessionId: row.session_id,
    userId: row.user_id,
    title: row.title || '',
    personaName: row.persona_name,
    personaPrompt: row.persona_prompt || '',
    metadata: row.metadata || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    lastActiveAt: row.last_active_at || row.updated_at || row.created_at || null,
  };
}

function parseJsonColumn(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function normaliseFloppyRow(row) {
  if (!row) return null;
  const manualChunks = parseJsonColumn(row.manual_chunks, []) || [];
  const knowledgeFiles = parseJsonColumn(row.knowledge_files, []) || [];
  const fileChunks = knowledgeFiles
    .flatMap((file) => (Array.isArray(file?.chunks) ? file.chunks : []));
  const knowledgeChunks = [...manualChunks, ...fileChunks];
  const rawMetadata = parseJsonColumn(row.metadata, null);
  const knowledgeGroups = Array.isArray(rawMetadata?.knowledgeGroups) ? rawMetadata.knowledgeGroups : [];
  const metadata = rawMetadata && typeof rawMetadata === 'object'
    ? Object.keys(rawMetadata).reduce((acc, key) => {
        if (key === 'knowledgeGroups') return acc;
        acc[key] = rawMetadata[key];
        return acc;
      }, {})
    : rawMetadata;
  const normalisedGroups = knowledgeGroups.map((group) => ({
    id: group?.id,
    name: group?.name || 'Untitled context',
    description: group?.description || '',
  }));
  return {
    id: row.id,
    tenantId: row.tenant_id,
    title: row.title,
    description: row.description || '',
    level: row.level || 'primary',
    knowledge: row.knowledge || '',
    manualChunks,
    knowledgeFiles,
    knowledgeChunks,
    knowledgeChunkCount: row.knowledge_chunk_count ?? knowledgeChunks.length,
    metadata,
    knowledgeGroups: normalisedGroups,
    createdBy: row.created_by || null,
    updatedBy: row.updated_by || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function normaliseSandboxRow(row) {
  if (!row) return null;
  const characterCard = parseJsonColumn(row.character_card, null) || null;
  const metadata = parseJsonColumn(row.metadata, null) || null;
  const safeCharacterCard = characterCard && typeof characterCard === 'object'
    ? {
        name: characterCard.name || '',
        prompt: characterCard.prompt || '',
        avatar: characterCard.avatar || null,
        background: characterCard.background || null,
      }
    : { name: '', prompt: '', avatar: null, background: null };
  return {
    id: row.id,
    tenantId: row.tenant_id,
    title: row.title || '',
    floppyId: row.floppy_id || null,
    personaPrompt: row.persona_prompt || '',
    characterCard: safeCharacterCard,
    metadata,
    createdBy: row.created_by || null,
    updatedBy: row.updated_by || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

class PgBaseStore {
  constructor(options = {}) {
    const {
      connectionString,
      ssl = parseBoolean(process.env.POSTGRES_SSL, false),
      logger = console,
    } = options;

    if (!connectionString) {
      throw new Error('PostgreSQL connection string is required');
    }

    this.connectionString = connectionString;
    this.logger = logger;
    this.pool = new Pool({
      connectionString,
      ssl: ssl ? { rejectUnauthorized: false } : false,
    });
    this.ready = null;
  }

  async query(text, params = []) {
    const result = await this.pool.query(text, params);
    return result;
  }

  async close() {
    await this.pool.end();
  }
}

class PgUserStore extends PgBaseStore {
  constructor(options = {}) {
    super(options);
    const {
      tableName = 'users',
    } = options;
    this.tableName = tableName;
  }

  async init() {
    if (!this.ready) {
      this.ready = this.query(`
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          user_id TEXT PRIMARY KEY,
          display_name TEXT,
          avatar TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `).then(() => {
        return this.query(`
          CREATE OR REPLACE FUNCTION set_${this.tableName}_updated_at()
          RETURNS TRIGGER AS $$
          BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql;
        `);
      }).then(() => {
        return this.query(`
          CREATE TRIGGER ${this.tableName}_set_updated_at
          BEFORE UPDATE ON ${this.tableName}
          FOR EACH ROW
          EXECUTE FUNCTION set_${this.tableName}_updated_at();
        `).catch(() => {});
      });
    }
    await this.ready;
  }

  async ensureDefaults(defaultUsers = DEFAULT_USERS) {
    await this.init();
    if (!Array.isArray(defaultUsers) || !defaultUsers.length) return;
    const values = defaultUsers.map((user) => [user.userId, user.displayName || user.userId, user.avatar || '']);
    const text = `
      INSERT INTO ${this.tableName} (user_id, display_name, avatar)
      VALUES ${values.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(',')}
      ON CONFLICT (user_id) DO NOTHING;
    `;
    const params = values.flat();
    if (!params.length) return;
    await this.query(text, params);
  }

  async list() {
    await this.init();
    const result = await this.query(`
      SELECT user_id, display_name, avatar
      FROM ${this.tableName}
      ORDER BY created_at ASC;
    `);
    return result.rows.map(normaliseUserRow);
  }

  async createUser(payload = {}) {
    await this.init();
    const result = await this.query(`
      INSERT INTO ${this.tableName} (user_id, display_name, avatar)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id) DO NOTHING
      RETURNING user_id, display_name, avatar;
    `, [payload.userId, payload.displayName || payload.userId, payload.avatar || '']);
    if (result.rows.length) return normaliseUserRow(result.rows[0]);
    throw Object.assign(new Error('User already exists'), { code: '23505' });
  }

  async updateUser(userId, payload = {}) {
    if (!userId) {
      throw new Error('User id is required for update');
    }
    await this.init();
    const updates = [];
    const params = [];
    let idx = 1;
    if (payload.displayName !== undefined) {
      updates.push(`display_name = $${idx++}`);
      params.push(payload.displayName);
    }
    if (payload.avatar !== undefined) {
      updates.push(`avatar = $${idx++}`);
      params.push(payload.avatar);
    }
    if (!updates.length) {
      const res = await this.query(`SELECT user_id, display_name, avatar FROM ${this.tableName} WHERE user_id = $1`, [userId]);
      return res.rows[0] ? normaliseUserRow(res.rows[0]) : null;
    }
    params.push(userId);
    const result = await this.query(`
      UPDATE ${this.tableName}
      SET ${updates.join(', ')}
      WHERE user_id = $${idx}
      RETURNING user_id, display_name, avatar;
    `, params);
    return result.rows[0] ? normaliseUserRow(result.rows[0]) : null;
  }

  async deleteUser(userId) {
    if (!userId) return;
    await this.init();
    await this.query(`DELETE FROM ${this.tableName} WHERE user_id = $1`, [userId]);
  }

  async connect() {
    await this.init();
    return this;
  }
}

class PgAuthStore extends PgBaseStore {
  constructor(options = {}) {
    super(options);
    const {
      tableName = 'user_credentials',
      saltRounds = 10,
    } = options;
    this.tableName = tableName;
    this.saltRounds = saltRounds;
  }

  async init() {
    if (!this.ready) {
      this.ready = this.query(`
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          user_id TEXT PRIMARY KEY,
          password_hash TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `).then(() => {
        return this.query(`
          CREATE OR REPLACE FUNCTION set_${this.tableName}_updated_at()
          RETURNS TRIGGER AS $$
          BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql;
        `);
      }).then(() => {
        return this.query(`
          CREATE TRIGGER ${this.tableName}_set_updated_at
          BEFORE UPDATE ON ${this.tableName}
          FOR EACH ROW
          EXECUTE FUNCTION set_${this.tableName}_updated_at();
        `).catch(() => {});
      });
    }
    await this.ready;
  }

  async hashPassword(password) {
    if (!password || typeof password !== 'string') {
      throw new Error('Password is required');
    }
    return bcrypt.hash(password, this.saltRounds);
  }

  async setCredential(userId, password) {
    if (!userId || !password) {
      throw new Error('userId and password are required');
    }
    await this.init();
    const passwordHash = await this.hashPassword(password);
    await this.query(`
      INSERT INTO ${this.tableName} (user_id, password_hash)
      VALUES ($1, $2)
      ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash;
    `, [userId, passwordHash]);
    return { userId };
  }

  async hasCredential(userId) {
    if (!userId) return false;
    await this.init();
    const result = await this.query(`SELECT 1 FROM ${this.tableName} WHERE user_id = $1`, [userId]);
    return result.rowCount > 0;
  }

  async verifyCredential(userId, password) {
    if (!userId || !password) return false;
    await this.init();
    const result = await this.query(`SELECT password_hash FROM ${this.tableName} WHERE user_id = $1`, [userId]);
    if (!result.rows[0]?.password_hash) return false;
    return bcrypt.compare(password, result.rows[0].password_hash);
  }

  async deleteCredential(userId) {
    if (!userId) return;
    await this.init();
    await this.query(`DELETE FROM ${this.tableName} WHERE user_id = $1`, [userId]);
  }

  async connect() {
    await this.init();
    return this;
  }
}

class PgSessionStore extends PgBaseStore {
  constructor(options = {}) {
    super(options);
    const {
      tableName = 'chat_sessions',
    } = options;
    this.tableName = tableName;
  }

  async init() {
    if (!this.ready) {
      this.ready = this.query(`
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          session_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          title TEXT,
          persona_name TEXT NOT NULL,
          persona_prompt TEXT,
          metadata JSONB,
          last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `).then(() => {
        return this.query(`
          CREATE OR REPLACE FUNCTION set_${this.tableName}_updated_at()
          RETURNS TRIGGER AS $$
          BEGIN
            NEW.updated_at = NOW();
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql;
        `);
      }).then(() => {
        return this.query(`
          CREATE TRIGGER ${this.tableName}_set_updated_at
          BEFORE UPDATE ON ${this.tableName}
          FOR EACH ROW
          EXECUTE FUNCTION set_${this.tableName}_updated_at();
        `).catch(() => {});
      }).then(() => this.query(`
        ALTER TABLE ${this.tableName}
        ADD COLUMN IF NOT EXISTS title TEXT;
      `));
    }
    await this.ready;
  }

  async upsertSession(payload = {}) {
    await this.init();
    const metadata = payload.metadata ? JSON.stringify(payload.metadata) : null;
    const result = await this.query(`
      INSERT INTO ${this.tableName} (session_id, user_id, title, persona_name, persona_prompt, metadata, last_active_at)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
      ON CONFLICT (session_id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        title = EXCLUDED.title,
        persona_name = EXCLUDED.persona_name,
        persona_prompt = EXCLUDED.persona_prompt,
        metadata = EXCLUDED.metadata,
        last_active_at = EXCLUDED.last_active_at
      RETURNING *;
    `, [
      payload.sessionId,
      payload.userId,
      payload.title || '',
      payload.personaName,
      payload.personaPrompt || '',
      metadata,
      payload.lastActiveAt || new Date(),
    ]);
    const row = result.rows[0];
    if (row && row.metadata && typeof row.metadata === 'string') {
      try {
        row.metadata = JSON.parse(row.metadata);
      } catch (_) {
        row.metadata = null;
      }
    }
    return normaliseSessionRow(row);
  }

  async list() {
    await this.init();
    const result = await this.query(`
      SELECT * FROM ${this.tableName}
      ORDER BY updated_at DESC;
    `);
    return result.rows.map((row) => {
      if (row.metadata && typeof row.metadata === 'string') {
        try {
          row.metadata = JSON.parse(row.metadata);
        } catch (_) {
          row.metadata = null;
        }
      }
      return normaliseSessionRow(row);
    });
  }

  async getBySessionId(sessionId) {
    if (!sessionId) return null;
    await this.init();
    const result = await this.query(`SELECT * FROM ${this.tableName} WHERE session_id = $1`, [sessionId]);
    const row = result.rows[0];
    if (row && row.metadata && typeof row.metadata === 'string') {
      try {
        row.metadata = JSON.parse(row.metadata);
      } catch (_) {
        row.metadata = null;
      }
    }
    return normaliseSessionRow(row);
  }

  async touchSession(sessionId) {
    if (!sessionId) return;
    await this.init();
    await this.query(`UPDATE ${this.tableName} SET last_active_at = NOW() WHERE session_id = $1`, [sessionId]);
  }

  async deleteSession(sessionId) {
    if (!sessionId) return;
    await this.init();
    await this.query(`DELETE FROM ${this.tableName} WHERE session_id = $1`, [sessionId]);
  }

  async updateTitle(sessionId, title) {
    if (!sessionId) return null;
    await this.init();
    const result = await this.query(`
      UPDATE ${this.tableName}
      SET title = $2
      WHERE session_id = $1
      RETURNING *;
    `, [sessionId, title || '']);
    const row = result.rows[0];
    if (!row) return null;
    if (row.metadata && typeof row.metadata === 'string') {
      try { row.metadata = JSON.parse(row.metadata); } catch (_) { row.metadata = null; }
    }
    return normaliseSessionRow(row);
  }

  async connect() {
    await this.init();
    return this;
  }
}

class PgMessageStore extends PgBaseStore {
  constructor(options = {}) {
    super(options);
    const {
      tableName = 'chat_messages',
    } = options;
    this.tableName = tableName;
  }

  async init() {
    if (!this.ready) {
      this.ready = this.query(`
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          id BIGSERIAL PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT fk_${this.tableName}_session FOREIGN KEY (session_id)
            REFERENCES chat_sessions (session_id)
            ON DELETE CASCADE
        );
      `).then(() => this.query(`
        CREATE INDEX IF NOT EXISTS idx_${this.tableName}_session_created_at
        ON ${this.tableName} (session_id, created_at);
      `));
    }
    await this.ready;
  }

  async appendMessages(sessionId, entries = []) {
    if (!sessionId || !entries.length) return;
    await this.init();
    const values = entries.map((_, index) => `($1, $${index * 3 + 2}, $${index * 3 + 3}, $${index * 3 + 4})`).join(', ');
    const text = `
      INSERT INTO ${this.tableName} (session_id, role, content, created_at)
      VALUES ${values};
    `;
    const params = [sessionId];
    entries.forEach((entry) => {
      params.push(entry.role);
      params.push(entry.content);
      params.push(entry.createdAt || new Date());
    });
    await this.query(text, params);
  }

  async list(sessionId, limit = null) {
    if (!sessionId) return [];
    await this.init();
    const text = `
      SELECT id, session_id, role, content, created_at
      FROM ${this.tableName}
      WHERE session_id = $1
      ORDER BY created_at ASC${limit ? ` LIMIT ${Number(limit)}` : ''};
    `;
    const result = await this.query(text, [sessionId]);
    return result.rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  async deleteBySession(sessionId) {
    if (!sessionId) return;
    await this.init();
    await this.query(`DELETE FROM ${this.tableName} WHERE session_id = $1`, [sessionId]);
  }

  async connect() {
    await this.init();
    return this;
  }
}

class PgFloppyStore extends PgBaseStore {
  constructor(options = {}) {
    super(options);
    const {
      tableName = 'floppies',
    } = options;
    this.tableName = tableName;
  }

  async init() {
    if (!this.ready) {
      this.ready = this.query(`
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          level TEXT NOT NULL DEFAULT 'primary',
          knowledge TEXT,
          manual_chunks JSONB,
          knowledge_files JSONB,
          knowledge_chunk_count INTEGER NOT NULL DEFAULT 0,
          metadata JSONB,
          created_by TEXT,
          updated_by TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `).then(() => this.query(`
        CREATE OR REPLACE FUNCTION set_${this.tableName}_updated_at()
        RETURNS TRIGGER AS $$
        BEGIN
          NEW.updated_at = NOW();
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `)).then(() => this.query(`
        CREATE TRIGGER ${this.tableName}_set_updated_at
        BEFORE UPDATE ON ${this.tableName}
        FOR EACH ROW
        EXECUTE FUNCTION set_${this.tableName}_updated_at();
      `).catch(() => {})).then(() => this.query(`
        CREATE INDEX IF NOT EXISTS idx_${this.tableName}_tenant_updated
        ON ${this.tableName} (tenant_id, updated_at DESC);
      `));
    }
    await this.ready;
  }

  async listByTenant(tenantId) {
    await this.init();
    let result;
    if (tenantId) {
      result = await this.query(`
        SELECT *
        FROM ${this.tableName}
        WHERE tenant_id = $1
        ORDER BY updated_at DESC;
      `, [tenantId]);
    } else {
      result = await this.query(`
        SELECT *
        FROM ${this.tableName}
        ORDER BY updated_at DESC;
      `);
    }
    return result.rows.map(normaliseFloppyRow);
  }

  async get(id) {
    if (!id) return null;
    await this.init();
    const result = await this.query(`
      SELECT *
      FROM ${this.tableName}
      WHERE id = $1
      LIMIT 1;
    `, [id]);
    return result.rows[0] ? normaliseFloppyRow(result.rows[0]) : null;
  }

  async insert(record) {
    await this.init();
    const result = await this.query(`
      INSERT INTO ${this.tableName} (
        id, tenant_id, title, description, level, knowledge,
        manual_chunks, knowledge_files, knowledge_chunk_count, metadata,
        created_by, updated_by
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7::jsonb, $8::jsonb, $9, $10::jsonb,
        $11, $12
      )
      RETURNING *;
    `, [
      record.id,
      record.tenantId,
      record.title,
      record.description,
      record.level,
      record.knowledge,
      JSON.stringify(record.manualChunks || []),
      JSON.stringify(record.knowledgeFiles || []),
      record.knowledgeChunkCount ?? 0,
      record.metadata ? JSON.stringify(record.metadata) : null,
      record.createdBy || record.tenantId || null,
      record.updatedBy || record.createdBy || record.tenantId || null,
    ]);
    return normaliseFloppyRow(result.rows[0]);
  }

  async update(id, record) {
    if (!id) throw new Error('Floppy id is required');
    await this.init();
    const result = await this.query(`
      UPDATE ${this.tableName}
      SET
        title = $2,
        description = $3,
        level = $4,
        knowledge = $5,
        manual_chunks = $6::jsonb,
        knowledge_files = $7::jsonb,
        knowledge_chunk_count = $8,
        metadata = $9::jsonb,
        updated_by = $10
      WHERE id = $1
      RETURNING *;
    `, [
      id,
      record.title,
      record.description,
      record.level,
      record.knowledge,
      JSON.stringify(record.manualChunks || []),
      JSON.stringify(record.knowledgeFiles || []),
      record.knowledgeChunkCount ?? 0,
      record.metadata ? JSON.stringify(record.metadata) : null,
      record.updatedBy || record.tenantId || null,
    ]);
    return result.rows[0] ? normaliseFloppyRow(result.rows[0]) : null;
  }

  async delete(id) {
    if (!id) return false;
    await this.init();
    const result = await this.query(`
      DELETE FROM ${this.tableName}
      WHERE id = $1;
    `, [id]);
    return result.rowCount > 0;
  }

  async connect() {
    await this.init();
    return this;
  }
}

class PgSandboxStore extends PgBaseStore {
  constructor(options = {}) {
    super(options);
    const {
      tableName = 'sandboxes',
    } = options;
    this.tableName = tableName;
  }

  async init() {
    if (!this.ready) {
      this.ready = this.query(`
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          floppy_id TEXT,
          title TEXT,
          persona_prompt TEXT,
          character_card JSONB,
          metadata JSONB,
          created_by TEXT,
          updated_by TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `).then(() => this.query(`
        CREATE OR REPLACE FUNCTION set_${this.tableName}_updated_at()
        RETURNS TRIGGER AS $$
        BEGIN
          NEW.updated_at = NOW();
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `)).then(() => this.query(`
        CREATE TRIGGER ${this.tableName}_set_updated_at
        BEFORE UPDATE ON ${this.tableName}
        FOR EACH ROW
        EXECUTE FUNCTION set_${this.tableName}_updated_at();
      `).catch(() => {})).then(() => this.query(`
        CREATE INDEX IF NOT EXISTS idx_${this.tableName}_tenant_updated
        ON ${this.tableName} (tenant_id, updated_at DESC);
      `));
    }
    await this.ready;
  }

  async listByTenant(tenantId) {
    await this.init();
    let result;
    if (tenantId) {
      result = await this.query(`
        SELECT *
        FROM ${this.tableName}
        WHERE tenant_id = $1
        ORDER BY updated_at DESC;
      `, [tenantId]);
    } else {
      result = await this.query(`
        SELECT *
        FROM ${this.tableName}
        ORDER BY updated_at DESC;
      `);
    }
    return result.rows.map(normaliseSandboxRow);
  }

  async get(id) {
    if (!id) return null;
    await this.init();
    const result = await this.query(`
      SELECT *
      FROM ${this.tableName}
      WHERE id = $1
      LIMIT 1;
    `, [id]);
    return result.rows[0] ? normaliseSandboxRow(result.rows[0]) : null;
  }

  async insert(record) {
    await this.init();
    const result = await this.query(`
      INSERT INTO ${this.tableName} (
        id, tenant_id, floppy_id, title, persona_prompt,
        character_card, metadata, created_by, updated_by
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6::jsonb, $7::jsonb, $8, $9
      )
      RETURNING *;
    `, [
      record.id,
      record.tenantId,
      record.floppyId || null,
      record.title || '',
      record.personaPrompt || '',
      record.characterCard ? JSON.stringify(record.characterCard) : null,
      record.metadata ? JSON.stringify(record.metadata) : null,
      record.createdBy || record.tenantId || null,
      record.updatedBy || record.createdBy || record.tenantId || null,
    ]);
    return normaliseSandboxRow(result.rows[0]);
  }

  async update(id, record) {
    if (!id) throw new Error('Sandbox id is required');
    await this.init();
    const result = await this.query(`
      UPDATE ${this.tableName}
      SET
        floppy_id = $2,
        title = $3,
        persona_prompt = $4,
        character_card = $5::jsonb,
        metadata = $6::jsonb,
        updated_by = $7
      WHERE id = $1
      RETURNING *;
    `, [
      id,
      record.floppyId || null,
      record.title || '',
      record.personaPrompt || '',
      record.characterCard ? JSON.stringify(record.characterCard) : null,
      record.metadata ? JSON.stringify(record.metadata) : null,
      record.updatedBy || record.tenantId || null,
    ]);
    return result.rows[0] ? normaliseSandboxRow(result.rows[0]) : null;
  }

  async delete(id) {
    if (!id) return false;
    await this.init();
    const result = await this.query(`
      DELETE FROM ${this.tableName}
      WHERE id = $1;
    `, [id]);
    return result.rowCount > 0;
  }

  async connect() {
    await this.init();
    return this;
  }
}

module.exports = {
  PgUserStore,
  PgAuthStore,
  PgSessionStore,
  PgMessageStore,
  PgFloppyStore,
  PgSandboxStore,
};
