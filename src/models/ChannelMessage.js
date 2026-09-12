const { db } = require('../config/database');

const ChannelMessage = {
  create({
    channelId,
    senderId,
    content = null,
    type = 'text',
    attachmentUrl = null,
    attachmentName = null,
    attachmentSize = null,
    attachmentMime = null,
  }) {
    const info = db
      .prepare(
        `INSERT INTO channel_messages (channel_id, sender_id, content, type, attachment_url, attachment_name, attachment_size, attachment_mime)
         VALUES (@channelId, @senderId, @content, @type, @attachmentUrl, @attachmentName, @attachmentSize, @attachmentMime)`
      )
      .run({ channelId, senderId, content, type, attachmentUrl, attachmentName, attachmentSize, attachmentMime });
    return ChannelMessage.findById(info.lastInsertRowid);
  },

  findById(id) {
    return db.prepare(`SELECT * FROM channel_messages WHERE id = ?`).get(id);
  },

  // История канала вместе с базовыми данными автора (имя/аватар) — чтобы не
  // делать по отдельному запросу на каждого автора на клиенте.
  getHistory(channelId, { limit = 50, offset = 0 } = {}) {
    return db
      .prepare(
        `SELECT cm.*, u.username AS sender_username, u.name AS sender_name, u.avatar_url AS sender_avatar_url
         FROM channel_messages cm
         JOIN users u ON u.id = cm.sender_id
         WHERE cm.channel_id = ?
         ORDER BY cm.created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(channelId, limit, offset);
  },

  delete(id) {
    return db.prepare(`DELETE FROM channel_messages WHERE id = ?`).run(id);
  },
};

module.exports = ChannelMessage;
