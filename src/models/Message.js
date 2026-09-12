const { db } = require('../config/database');

const Message = {
  create({
    senderId,
    receiverId,
    content = null,
    type = 'text',
    attachmentUrl = null,
    attachmentName = null,
    attachmentSize = null,
    attachmentMime = null,
  }) {
    const stmt = db.prepare(`
      INSERT INTO messages (sender_id, receiver_id, content, type, attachment_url, attachment_name, attachment_size, attachment_mime)
      VALUES (@senderId, @receiverId, @content, @type, @attachmentUrl, @attachmentName, @attachmentSize, @attachmentMime)
    `);
    const info = stmt.run({
      senderId,
      receiverId,
      content,
      type,
      attachmentUrl,
      attachmentName,
      attachmentSize,
      attachmentMime,
    });
    return Message.findById(info.lastInsertRowid);
  },

  findById(id) {
    return db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id);
  },

  // Диалог между meId и otherId, с точки зрения meId — сообщения, которые meId
  // ранее скрыл себе ("удалить у меня"), сюда не попадают, даже если для
  // второй стороны они всё ещё видны.
  getConversation(meId, otherId, { limit = 50, offset = 0 } = {}) {
    return db
      .prepare(
        `SELECT * FROM messages
         WHERE ((sender_id = @meId AND receiver_id = @otherId) OR (sender_id = @otherId AND receiver_id = @meId))
           AND NOT (sender_id = @meId AND deleted_for_sender = 1)
           AND NOT (receiver_id = @meId AND deleted_for_receiver = 1)
         ORDER BY created_at DESC
         LIMIT @limit OFFSET @offset`
      )
      .all({ meId, otherId, limit, offset });
  },

  // Список последних диалогов пользователя (для списка чатов)
  getRecentConversations(userId, { limit = 30 } = {}) {
    return db
      .prepare(
        `SELECT m.*
         FROM messages m
         INNER JOIN (
           SELECT
             CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END AS partner_id,
             MAX(created_at) AS last_created_at
           FROM messages
           WHERE sender_id = ? OR receiver_id = ?
           GROUP BY partner_id
         ) latest
           ON latest.last_created_at = m.created_at
          AND (m.sender_id = latest.partner_id OR m.receiver_id = latest.partner_id)
         ORDER BY m.created_at DESC
         LIMIT ?`
      )
      .all(userId, userId, userId, limit);
  },

  markAsRead(receiverId, senderId) {
    db.prepare(
      `UPDATE messages SET is_read = 1
       WHERE receiver_id = ? AND sender_id = ? AND is_read = 0`
    ).run(receiverId, senderId);
  },

  getUnreadCount(userId) {
    return db
      .prepare(
        `SELECT COUNT(*) AS count FROM messages WHERE receiver_id = ? AND is_read = 0`
      )
      .get(userId).count;
  },

  delete(id) {
    return db.prepare(`DELETE FROM messages WHERE id = ?`).run(id);
  },

  // "Удалить у меня" — ставит флаг только для стороны requestingUserId.
  // Если после этого флаг стоит У ОБЕИХ сторон — сообщение физически стирается
  // из базы (и вызывающий код должен удалить файл вложения с диска), чтобы
  // не копить в БД и в uploads/ то, что уже никому не видно.
  markDeletedForUser(id, requestingUserId) {
    const msg = Message.findById(id);
    if (!msg) return null;
    if (msg.sender_id !== requestingUserId && msg.receiver_id !== requestingUserId) {
      return { error: 'forbidden' };
    }

    if (msg.sender_id === requestingUserId) {
      db.prepare(`UPDATE messages SET deleted_for_sender = 1 WHERE id = ?`).run(id);
    } else {
      db.prepare(`UPDATE messages SET deleted_for_receiver = 1 WHERE id = ?`).run(id);
    }

    const updated = Message.findById(id);
    const bothHidden = !!updated.deleted_for_sender && !!updated.deleted_for_receiver;
    if (bothHidden) {
      Message.delete(id);
      return { message: updated, purged: true };
    }
    return { message: updated, purged: false };
  },

  // "Удалить у всех" — разрешено только автору сообщения, стирает сразу и физически.
  markDeletedForEveryone(id, requestingUserId) {
    const msg = Message.findById(id);
    if (!msg) return null;
    if (msg.sender_id !== requestingUserId) return { error: 'forbidden' };

    Message.delete(id);
    return { message: msg, purged: true };
  },
};

module.exports = Message;
