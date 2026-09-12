const { db } = require('../config/database');

// Полный список известных прав. ADMINISTRATOR перекрывает всё остальное (как в Discord).
const PERMISSIONS = [
  'ADMINISTRATOR',
  'MANAGE_SERVER',
  'MANAGE_ROLES',
  'MANAGE_CHANNELS',
  'KICK_MEMBERS',
  'BAN_MEMBERS',
];

function parsePermissions(json) {
  try {
    const arr = JSON.parse(json || '[]');
    return Array.isArray(arr) ? arr.filter((p) => PERMISSIONS.includes(p)) : [];
  } catch (e) {
    return [];
  }
}

const Role = {
  PERMISSIONS,

  create({ serverId, name, color = '#99AAB5', permissions = [] }) {
    const maxPos = db
      .prepare(`SELECT COALESCE(MAX(position), 0) AS maxPos FROM roles WHERE server_id = ?`)
      .get(serverId).maxPos;
    const info = db
      .prepare(`INSERT INTO roles (server_id, name, color, position, permissions) VALUES (?, ?, ?, ?, ?)`)
      .run(serverId, name, color, maxPos + 1, JSON.stringify(permissions.filter((p) => PERMISSIONS.includes(p))));
    return Role.findById(info.lastInsertRowid);
  },

  findById(id) {
    const row = db.prepare(`SELECT * FROM roles WHERE id = ?`).get(id);
    if (!row) return null;
    return { ...row, permissions: parsePermissions(row.permissions) };
  },

  listForServer(serverId) {
    return db
      .prepare(`SELECT * FROM roles WHERE server_id = ? ORDER BY position DESC`)
      .all(serverId)
      .map((row) => ({ ...row, permissions: parsePermissions(row.permissions) }));
  },

  update(id, { name, color, permissions }) {
    const current = Role.findById(id);
    if (!current) return null;
    db.prepare(`UPDATE roles SET name = ?, color = ?, permissions = ? WHERE id = ?`).run(
      name ?? current.name,
      color ?? current.color,
      JSON.stringify((permissions ?? current.permissions).filter((p) => PERMISSIONS.includes(p))),
      id
    );
    return Role.findById(id);
  },

  delete(id) {
    return db.prepare(`DELETE FROM roles WHERE id = ?`).run(id);
  },

  assignToMember(serverId, userId, roleId) {
    db.prepare(`INSERT OR IGNORE INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)`).run(
      serverId,
      userId,
      roleId
    );
  },

  removeFromMember(serverId, userId, roleId) {
    db.prepare(`DELETE FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?`).run(
      serverId,
      userId,
      roleId
    );
  },

  // Роли конкретного участника на сервере
  getMemberRoles(serverId, userId) {
    return db
      .prepare(
        `SELECT r.* FROM roles r
         JOIN member_roles mr ON mr.role_id = r.id
         WHERE mr.server_id = ? AND mr.user_id = ?
         ORDER BY r.position DESC`
      )
      .all(serverId, userId)
      .map((row) => ({ ...row, permissions: parsePermissions(row.permissions) }));
  },

  // Все назначения ролей на сервере разом (для отрисовки списка участников одним запросом)
  getAllAssignments(serverId) {
    return db
      .prepare(`SELECT user_id, role_id FROM member_roles WHERE server_id = ?`)
      .all(serverId);
  },

  // Есть ли у участника конкретное право (ADMINISTRATOR перекрывает всё)
  hasPermission(serverId, userId, permission) {
    const roles = Role.getMemberRoles(serverId, userId);
    return roles.some((r) => r.permissions.includes('ADMINISTRATOR') || r.permissions.includes(permission));
  },

  // "Админ" в широком смысле — используется, например, для проверки права писать
  // в тему, закрытую для обычных участников.
  isAdmin(serverId, userId) {
    return Role.hasPermission(serverId, userId, 'ADMINISTRATOR');
  },
};

module.exports = Role;
