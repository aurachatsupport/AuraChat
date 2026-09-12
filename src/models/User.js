const { db } = require('../config/database');

const User = {
  create({ username, email, passwordHash, name = null }) {
    const stmt = db.prepare(`
      INSERT INTO users (username, email, password_hash, name)
      VALUES (@username, @email, @passwordHash, @name)
    `);
    const info = stmt.run({ username, email, passwordHash, name: name || username });
    return User.findById(info.lastInsertRowid);
  },

  findById(id) {
    return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
  },

  findByUsername(username) {
    return db.prepare(`SELECT * FROM users WHERE username = ?`).get(username);
  },

  findByEmail(email) {
    return db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
  },

  // Поиск по username ИЛИ email — удобно для формы логина
  findByUsernameOrEmail(identifier) {
    return db
      .prepare(`SELECT * FROM users WHERE username = ? OR email = ?`)
      .get(identifier, identifier);
  },

  findAll({ limit = 50, offset = 0, search = null, excludeId = null } = {}) {
    const excludeClause = excludeId ? `AND id != @excludeId` : '';
    const baseSelect = `
      SELECT id, username, name, bio, avatar_url, status, last_seen, show_online, created_at
      FROM users
      WHERE 1=1 ${excludeClause}
    `;
    if (search) {
      // Совпадения "начинается с..." идут выше совпадений "содержит где-то внутри" —
      // так набор "user" сначала покажет "user", "user123", а не "myuser42".
      return db
        .prepare(
          `${baseSelect} AND (username LIKE @search OR name LIKE @search)
           ORDER BY (CASE WHEN username LIKE @prefixSearch THEN 0 ELSE 1 END), username
           LIMIT @limit OFFSET @offset`
        )
        .all({ search: `%${search}%`, prefixSearch: `${search}%`, limit, offset, excludeId });
    }
    return db
      .prepare(`${baseSelect} ORDER BY username LIMIT @limit OFFSET @offset`)
      .all({ limit, offset, excludeId });
  },

  updateAvatar(id, avatarUrl) {
    db.prepare(`UPDATE users SET avatar_url = ? WHERE id = ?`).run(avatarUrl, id);
    return User.findById(id);
  },

  updateStatus(id, status) {
    db.prepare(
      `UPDATE users SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(status, id);
  },

  // Частичное обновление профиля — обновляются только переданные поля.
  updateProfile(id, fields) {
    const current = User.findById(id);
    if (!current) return null;

    const allowed = ['username', 'email', 'name', 'bio', 'birthdate', 'language'];
    const updates = {};
    for (const key of allowed) {
      if (fields[key] !== undefined) updates[key] = fields[key];
    }
    if (Object.keys(updates).length === 0) return current;

    const setClause = Object.keys(updates)
      .map((key) => `${key} = @${key}`)
      .join(', ');
    db.prepare(`UPDATE users SET ${setClause} WHERE id = @id`).run({ ...updates, id });

    return User.findById(id);
  },

  // Настройки приватности — "показывать в сети" и "статус прочтения".
  updatePrivacy(id, { showOnline, readReceiptsEnabled }) {
    const updates = {};
    if (showOnline !== undefined) updates.show_online = showOnline ? 1 : 0;
    if (readReceiptsEnabled !== undefined) updates.read_receipts_enabled = readReceiptsEnabled ? 1 : 0;
    if (Object.keys(updates).length === 0) return User.findById(id);

    const setClause = Object.keys(updates)
      .map((key) => `${key} = @${key}`)
      .join(', ');
    db.prepare(`UPDATE users SET ${setClause} WHERE id = @id`).run({ ...updates, id });
    return User.findById(id);
  },

  hasReadReceipts(id) {
    const row = db.prepare(`SELECT read_receipts_enabled FROM users WHERE id = ?`).get(id);
    return !!(row && row.read_receipts_enabled);
  },

  updatePasswordHash(id, passwordHash) {
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(passwordHash, id);
  },

  updatePin(id, pinHash) {
    db.prepare(`UPDATE users SET pin_hash = ? WHERE id = ?`).run(pinHash, id);
    return User.findById(id);
  },

  removePin(id) {
    db.prepare(`UPDATE users SET pin_hash = NULL WHERE id = ?`).run(id);
  },

  // ---- 2FA (TOTP) ----
  setTotpSecret(id, secret) {
    // Секрет сохраняется ДО подтверждения (totp_enabled остаётся 0), чтобы
    // не включать 2FA, пока пользователь не введёт верный код из приложения.
    db.prepare(`UPDATE users SET totp_secret = ? WHERE id = ?`).run(secret, id);
  },

  enableTotp(id) {
    db.prepare(`UPDATE users SET totp_enabled = 1 WHERE id = ?`).run(id);
    return User.findById(id);
  },

  disableTotp(id) {
    db.prepare(`UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?`).run(id);
  },

  // ---- Подтверждение email ----
  setEmailVerificationCode(id, code, expiresAt) {
    db.prepare(
      `UPDATE users SET email_verification_code = ?, email_verification_expires = ?, email_verification_sent_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(code, expiresAt, id);
  },

  // Возвращает true при успехе. false — если кода нет, он не совпал или истёк.
  verifyEmailCode(id, code) {
    const user = User.findById(id);
    if (!user || !user.email_verification_code) return false;
    if (user.email_verification_code !== String(code)) return false;
    if (!user.email_verification_expires || new Date(user.email_verification_expires) < new Date()) return false;

    db.prepare(
      `UPDATE users SET email_verified = 1, email_verification_code = NULL, email_verification_expires = NULL WHERE id = ?`
    ).run(id);
    return true;
  },

  // Простая защита от спама повторной отправкой — не чаще раза в 60 секунд
  canResendVerification(id) {
    const user = User.findById(id);
    if (!user || !user.email_verification_sent_at) return true;
    const secondsSinceSent = (Date.now() - new Date(user.email_verification_sent_at).getTime()) / 1000;
    return secondsSinceSent >= 60;
  },

  // ---- Бан (админ-тул) ----
  ban(id, reason) {
    db.prepare(
      `UPDATE users SET is_banned = 1, ban_reason = ?, banned_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(reason || null, id);
    return User.findById(id);
  },

  unban(id) {
    db.prepare(
      `UPDATE users SET is_banned = 0, ban_reason = NULL, banned_at = NULL WHERE id = ?`
    ).run(id);
    return User.findById(id);
  },

  delete(id) {
    return db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
  },

  // Профиль ДЛЯ АДМИНА — видно всё существенное (кроме секретов), включая
  // статус верификации/бана, которых обычный пользователь о себе видит меньше.
  toAdminView(user) {
    if (!user) return null;
    const { password_hash, pin_hash, totp_secret, email_verification_code, ...rest } = user;
    return {
      ...rest,
      showOnline: !!rest.show_online,
      readReceiptsEnabled: !!rest.read_receipts_enabled,
      totpEnabled: !!rest.totp_enabled,
      emailVerified: !!rest.email_verified,
      hasPinLock: !!pin_hash,
      isBanned: !!rest.is_banned,
    };
  },

  // Полный профиль ДЛЯ САМОГО ПОЛЬЗОВАТЕЛЯ (свои настройки видны целиком)
  toPublic(user) {
    if (!user) return null;
    const { password_hash, pin_hash, totp_secret, email_verification_code, ...rest } = user;
    return {
      ...rest,
      showOnline: !!rest.show_online,
      readReceiptsEnabled: !!rest.read_receipts_enabled,
      totpEnabled: !!rest.totp_enabled,
      emailVerified: !!rest.email_verified,
      hasPinLock: !!pin_hash,
    };
  },

  // Профиль пользователя ГЛАЗАМИ ДРУГОГО человека — маскирует status/last_seen,
  // если владелец профиля выключил "показывать в сети", и убирает служебные поля.
  toContactView(user) {
    if (!user) return null;
    const showOnline = user.show_online === undefined ? true : !!user.show_online;
    return {
      id: user.id,
      username: user.username,
      name: user.name,
      bio: user.bio,
      avatar_url: user.avatar_url,
      status: showOnline ? user.status : 'hidden',
      last_seen: showOnline ? user.last_seen : null,
    };
  },
};

module.exports = User;
