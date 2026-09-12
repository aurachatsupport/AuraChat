const crypto = require('crypto');
const { db } = require('../config/database');

function generateInviteCode() {
  return crypto.randomBytes(5).toString('hex'); // 10 символов, например "a1b2c3d4e5"
}

const Server = {
  create({ name, ownerId }) {
    let inviteCode = generateInviteCode();
    // На случай коллизии (крайне маловероятно, но проверим) — перегенерируем.
    while (db.prepare(`SELECT id FROM servers WHERE invite_code = ?`).get(inviteCode)) {
      inviteCode = generateInviteCode();
    }

    const info = db
      .prepare(`INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)`)
      .run(name, ownerId, inviteCode);
    const server = Server.findById(info.lastInsertRowid);

    Server.addMember(server.id, ownerId, 'owner');
    return server;
  },

  findById(id) {
    return db.prepare(`SELECT * FROM servers WHERE id = ?`).get(id);
  },

  findByInviteCode(code) {
    return db.prepare(`SELECT * FROM servers WHERE invite_code = ?`).get(code);
  },

  // Принимает либо числовой id, либо инвайт-код — удобно для админ-тула,
  // где неизвестно заранее, что именно ввели.
  findByIdOrInviteCode(identifier) {
    if (/^\d+$/.test(String(identifier))) {
      const byId = Server.findById(Number(identifier));
      if (byId) return byId;
    }
    return Server.findByInviteCode(String(identifier));
  },

  // Все сервера, где userId состоит участником
  listForUser(userId) {
    return db
      .prepare(
        `SELECT s.* FROM servers s
         JOIN server_members sm ON sm.server_id = s.id
         WHERE sm.user_id = ?
         ORDER BY s.created_at`
      )
      .all(userId);
  },

  addMember(serverId, userId, role = 'member') {
    db.prepare(
      `INSERT OR IGNORE INTO server_members (server_id, user_id, role) VALUES (?, ?, ?)`
    ).run(serverId, userId, role);
  },

  removeMember(serverId, userId) {
    db.prepare(`DELETE FROM server_members WHERE server_id = ? AND user_id = ?`).run(serverId, userId);
  },

  isMember(serverId, userId) {
    return !!db
      .prepare(`SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?`)
      .get(serverId, userId);
  },

  isOwner(serverId, userId) {
    const server = Server.findById(serverId);
    return !!server && server.owner_id === userId;
  },

  listMembers(serverId) {
    return db
      .prepare(
        `SELECT u.id, u.username, u.name, u.avatar_url, u.status, sm.role, sm.joined_at
         FROM server_members sm
         JOIN users u ON u.id = sm.user_id
         WHERE sm.server_id = ?
         ORDER BY sm.role = 'owner' DESC, u.username`
      )
      .all(serverId);
  },

  updateName(id, name) {
    db.prepare(`UPDATE servers SET name = ? WHERE id = ?`).run(name, id);
    return Server.findById(id);
  },

  updateAvatar(id, avatarUrl) {
    db.prepare(`UPDATE servers SET avatar_url = ? WHERE id = ?`).run(avatarUrl, id);
    return Server.findById(id);
  },

  isBanned(id) {
    const server = Server.findById(id);
    return !!server?.is_banned;
  },

  ban(id, reason) {
    db.prepare(`UPDATE servers SET is_banned = 1, ban_reason = ?, banned_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
      reason || null,
      id
    );
    return Server.findById(id);
  },

  unban(id) {
    db.prepare(`UPDATE servers SET is_banned = 0, ban_reason = NULL, banned_at = NULL WHERE id = ?`).run(id);
    return Server.findById(id);
  },

  delete(id) {
    return db.prepare(`DELETE FROM servers WHERE id = ?`).run(id);
  },
};

module.exports = Server;
