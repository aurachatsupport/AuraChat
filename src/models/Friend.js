const { db } = require('../config/database');

// Таблица friends хранит одну строку на пару (user_id, friend_id) — направление
// user_id -> friend_id фиксирует, кто инициировал заявку/блокировку.
// Проверка дружбы между A и B всегда должна смотреть в обе стороны.

const Friend = {
  // Найти связь по её собственному id (нужно, например, чтобы узнать участников
  // перед удалением — после DELETE строку уже не прочитать).
  findRelationById(id) {
    return db.prepare(`SELECT * FROM friends WHERE id = ?`).get(id);
  },

  // Найти существующую связь между двумя пользователями в любом направлении
  findRelation(userId, otherId) {
    return db
      .prepare(
        `SELECT * FROM friends
         WHERE (user_id = ? AND friend_id = ?)
            OR (user_id = ? AND friend_id = ?)`
      )
      .get(userId, otherId, otherId, userId);
  },

  // Отправить заявку в друзья
  sendRequest(userId, friendId) {
    const stmt = db.prepare(`
      INSERT INTO friends (user_id, friend_id, status)
      VALUES (@userId, @friendId, 'pending')
    `);
    const info = stmt.run({ userId, friendId });
    return db.prepare(`SELECT * FROM friends WHERE id = ?`).get(info.lastInsertRowid);
  },

  // Принять заявку — обновляем статус строки, где userId был получателем (friend_id)
  acceptRequest(requestId, userId) {
    const req = db.prepare(`SELECT * FROM friends WHERE id = ?`).get(requestId);
    if (!req || req.friend_id !== userId || req.status !== 'pending') return null;
    db.prepare(
      `UPDATE friends SET status = 'accepted', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(requestId);
    return db.prepare(`SELECT * FROM friends WHERE id = ?`).get(requestId);
  },

  // Отклонить заявку или удалить существующую дружбу
  removeRelation(requestId, userId) {
    const req = db.prepare(`SELECT * FROM friends WHERE id = ?`).get(requestId);
    if (!req || (req.user_id !== userId && req.friend_id !== userId)) return false;
    db.prepare(`DELETE FROM friends WHERE id = ?`).run(requestId);
    return true;
  },

  // Заблокировать пользователя (создаёт или обновляет связь на статус 'blocked')
  block(userId, targetId) {
    const existing = Friend.findRelation(userId, targetId);
    if (existing) {
      db.prepare(
        `UPDATE friends SET status = 'blocked', user_id = ?, friend_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(userId, targetId, existing.id);
      return db.prepare(`SELECT * FROM friends WHERE id = ?`).get(existing.id);
    }
    return db
      .prepare(
        `INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, 'blocked')`
      )
      .run(userId, targetId);
  },

  // Список принятых друзей пользователя (с базовым публичным профилем).
  // status/last_seen маскируются, если у друга выключено "показывать в сети".
  listFriends(userId) {
    const rows = db
      .prepare(
        `SELECT u.id, u.username, u.name, u.avatar_url, u.status, u.last_seen, u.show_online, f.id AS relation_id
         FROM friends f
         JOIN users u ON u.id = CASE WHEN f.user_id = ? THEN f.friend_id ELSE f.user_id END
         WHERE (f.user_id = ? OR f.friend_id = ?) AND f.status = 'accepted'
         ORDER BY u.username`
      )
      .all(userId, userId, userId);

    return rows.map((row) => {
      const showOnline = !!row.show_online;
      const { show_online, ...rest } = row;
      return {
        ...rest,
        status: showOnline ? rest.status : 'hidden',
        last_seen: showOnline ? rest.last_seen : null,
      };
    });
  },

  // Входящие заявки (ожидают решения текущего пользователя)
  listIncomingRequests(userId) {
    return db
      .prepare(
        `SELECT f.id AS relation_id, f.created_at, u.id, u.username, u.name, u.avatar_url
         FROM friends f
         JOIN users u ON u.id = f.user_id
         WHERE f.friend_id = ? AND f.status = 'pending'
         ORDER BY f.created_at DESC`
      )
      .all(userId);
  },

  // Исходящие заявки (отправленные текущим пользователем, ещё не принятые)
  listOutgoingRequests(userId) {
    return db
      .prepare(
        `SELECT f.id AS relation_id, f.created_at, u.id, u.username, u.name, u.avatar_url
         FROM friends f
         JOIN users u ON u.id = f.friend_id
         WHERE f.user_id = ? AND f.status = 'pending'
         ORDER BY f.created_at DESC`
      )
      .all(userId);
  },

  areFriends(userId, otherId) {
    const rel = Friend.findRelation(userId, otherId);
    return !!(rel && rel.status === 'accepted');
  },
};

module.exports = Friend;
