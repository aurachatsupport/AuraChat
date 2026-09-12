const { db } = require('../config/database');

const Channel = {
  create({ serverId, name, type = 'text', restrictedToAdmins = false }) {
    const info = db
      .prepare(`INSERT INTO channels (server_id, name, type, restricted_to_admins) VALUES (?, ?, ?, ?)`)
      .run(serverId, name, type, restrictedToAdmins ? 1 : 0);
    return Channel.findById(info.lastInsertRowid);
  },

  findById(id) {
    return db.prepare(`SELECT * FROM channels WHERE id = ?`).get(id);
  },

  listForServer(serverId) {
    return db
      .prepare(`SELECT * FROM channels WHERE server_id = ? ORDER BY type, position, id`)
      .all(serverId);
  },

  setRestricted(id, restricted) {
    db.prepare(`UPDATE channels SET restricted_to_admins = ? WHERE id = ?`).run(restricted ? 1 : 0, id);
    return Channel.findById(id);
  },

  delete(id) {
    return db.prepare(`DELETE FROM channels WHERE id = ?`).run(id);
  },
};

module.exports = Channel;
