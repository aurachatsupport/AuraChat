const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'database.sqlite');

const db = new Database(DB_PATH);

// Рекомендуемые прагмы для веб-бэкенда на better-sqlite3
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Добавляет колонку в таблицу, если её ещё нет — простая миграция без внешних библиотек.
function ensureColumn(table, column, definition) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all();
  const hasColumn = existing.some((col) => col.name === column);
  if (!hasColumn) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[db] Миграция: добавлена колонка ${table}.${column}`);
  }
}

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name          TEXT,
      bio           TEXT,
      birthdate     TEXT,
      language      TEXT DEFAULT 'ru',
      avatar_url    TEXT,
      status        TEXT DEFAULT 'offline',
      pin_hash      TEXT,
      show_online          INTEGER DEFAULT 1, -- 0/1: показывать ли статус "в сети" другим
      read_receipts_enabled INTEGER DEFAULT 1, -- 0/1: отправлять и видеть статус прочтения
      totp_secret   TEXT,   -- секрет TOTP (base32), задаётся при настройке 2FA
      totp_enabled  INTEGER DEFAULT 0,
      email_verified            INTEGER DEFAULT 0,
      email_verification_code  TEXT,
      email_verification_expires DATETIME,
      email_verification_sent_at DATETIME,
      is_banned    INTEGER DEFAULT 0,
      ban_reason   TEXT,
      banned_at    DATETIME,
      last_seen     DATETIME,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id      INTEGER NOT NULL,
      receiver_id    INTEGER NOT NULL,
      content        TEXT,
      type           TEXT DEFAULT 'text',      -- text | image | file | audio | video | videonote
      attachment_url  TEXT,
      attachment_name TEXT,
      attachment_size INTEGER,
      attachment_mime TEXT,
      deleted_for_sender   INTEGER DEFAULT 0,
      deleted_for_receiver INTEGER DEFAULT 0,
      is_read        INTEGER DEFAULT 0,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sender_id)   REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Система контактов/друзей: заявка, принятие, блокировка.
    -- user_id — отправитель заявки на момент создания строки; статус меняется той же строкой.
    CREATE TABLE IF NOT EXISTS friends (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,   -- отправитель заявки
      friend_id   INTEGER NOT NULL,   -- получатель заявки
      status      TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | blocked
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id)   REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (friend_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE (user_id, friend_id)
    );

    -- Сервера (сообщества, как в Discord) — отдельная сущность от личных друзей.
    CREATE TABLE IF NOT EXISTS servers (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      owner_id     INTEGER NOT NULL,
      invite_code  TEXT NOT NULL UNIQUE,
      avatar_url   TEXT,
      is_banned    INTEGER DEFAULT 0,
      ban_reason   TEXT,
      banned_at    DATETIME,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS server_members (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id   INTEGER NOT NULL,
      user_id     INTEGER NOT NULL,
      role        TEXT NOT NULL DEFAULT 'member', -- owner | member
      joined_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id)   REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE (server_id, user_id)
    );

    -- Каналы внутри сервера — текстовые ("темы") и голосовые.
    CREATE TABLE IF NOT EXISTS channels (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id   INTEGER NOT NULL,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'text', -- text | voice
      position    INTEGER DEFAULT 0,
      restricted_to_admins INTEGER DEFAULT 0, -- "закрытая тема": писать могут только те, у кого есть право ADMINISTRATOR
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );

    -- Роли сервера — полноценные, как в Discord: имя/цвет/набор прав, назначаются участникам.
    CREATE TABLE IF NOT EXISTS roles (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id   INTEGER NOT NULL,
      name        TEXT NOT NULL,
      color       TEXT DEFAULT '#99AAB5',
      position    INTEGER DEFAULT 0,          -- выше число — выше роль в списке/приоритете отображения
      permissions TEXT NOT NULL DEFAULT '[]', -- JSON-массив строк: ADMINISTRATOR, MANAGE_SERVER, MANAGE_ROLES, MANAGE_CHANNELS, KICK_MEMBERS, BAN_MEMBERS
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS member_roles (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL,
      user_id   INTEGER NOT NULL,
      role_id   INTEGER NOT NULL,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id)   REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (role_id)   REFERENCES roles(id) ON DELETE CASCADE,
      UNIQUE (user_id, role_id)
    );

    -- Сообщения в текстовых каналах — отдельно от личных messages (там получатель
    -- один конкретный человек, здесь сообщение видно всем участникам сервера).
    CREATE TABLE IF NOT EXISTS channel_messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id      INTEGER NOT NULL,
      sender_id       INTEGER NOT NULL,
      content         TEXT,
      type            TEXT DEFAULT 'text',
      attachment_url  TEXT,
      attachment_name TEXT,
      attachment_size INTEGER,
      attachment_mime TEXT,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_id)  REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_sender    ON messages(sender_id);
    CREATE INDEX IF NOT EXISTS idx_messages_receiver  ON messages(receiver_id);
    CREATE INDEX IF NOT EXISTS idx_messages_pair       ON messages(sender_id, receiver_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_friends_user         ON friends(user_id);
    CREATE INDEX IF NOT EXISTS idx_friends_friend        ON friends(friend_id);
    CREATE INDEX IF NOT EXISTS idx_server_members_server ON server_members(server_id);
    CREATE INDEX IF NOT EXISTS idx_server_members_user   ON server_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_channels_server        ON channels(server_id);
    CREATE INDEX IF NOT EXISTS idx_roles_server            ON roles(server_id);
    CREATE INDEX IF NOT EXISTS idx_member_roles_server_user ON member_roles(server_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_member_roles_role        ON member_roles(role_id);
    CREATE INDEX IF NOT EXISTS idx_channel_messages_chan  ON channel_messages(channel_id, created_at);
  `);

  // Миграция для баз, созданных до появления этих полей.
  ensureColumn('users', 'name', 'TEXT');
  ensureColumn('users', 'bio', 'TEXT');
  ensureColumn('users', 'birthdate', 'TEXT');
  ensureColumn('users', 'language', "TEXT DEFAULT 'ru'");
  ensureColumn('users', 'pin_hash', 'TEXT');
  ensureColumn('users', 'show_online', 'INTEGER DEFAULT 1');
  ensureColumn('users', 'read_receipts_enabled', 'INTEGER DEFAULT 1');
  ensureColumn('users', 'totp_secret', 'TEXT');
  ensureColumn('users', 'totp_enabled', 'INTEGER DEFAULT 0');
  ensureColumn('users', 'email_verified', 'INTEGER DEFAULT 0');
  ensureColumn('users', 'email_verification_code', 'TEXT');
  ensureColumn('users', 'email_verification_expires', 'DATETIME');
  ensureColumn('users', 'email_verification_sent_at', 'DATETIME');
  ensureColumn('users', 'is_banned', 'INTEGER DEFAULT 0');
  ensureColumn('users', 'ban_reason', 'TEXT');
  ensureColumn('users', 'banned_at', 'DATETIME');
  ensureColumn('messages', 'attachment_name', 'TEXT');
  ensureColumn('messages', 'attachment_size', 'INTEGER');
  ensureColumn('messages', 'attachment_mime', 'TEXT');
  ensureColumn('messages', 'deleted_for_sender', 'INTEGER DEFAULT 0');
  ensureColumn('messages', 'deleted_for_receiver', 'INTEGER DEFAULT 0');
  ensureColumn('channels', 'restricted_to_admins', 'INTEGER DEFAULT 0');
  ensureColumn('servers', 'is_banned', 'INTEGER DEFAULT 0');
  ensureColumn('servers', 'ban_reason', 'TEXT');
  ensureColumn('servers', 'banned_at', 'DATETIME');

  console.log(`[db] SQLite инициализирована по пути: ${DB_PATH}`);
}

module.exports = { db, initDatabase, ensureColumn };
