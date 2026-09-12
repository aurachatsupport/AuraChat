const dns = require('dns').promises;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidFormat(email) {
  return typeof email === 'string' && EMAIL_RE.test(email);
}

// Best-effort проверка: есть ли у домена вообще почтовые сервера (MX-записи).
// Отсекает опечатки вроде "gmail.con" или несуществующие домены.
// НЕ доказывает, что конкретный ящик существует — только что домен в принципе
// может принимать почту. Настоящее доказательство существования ящика — это
// то, что владелец ввёл код, присланный именно на этот адрес.
async function domainCanReceiveMail(email) {
  const domain = (email || '').split('@')[1];
  if (!domain) return false;
  try {
    const records = await dns.resolveMx(domain);
    return Array.isArray(records) && records.length > 0;
  } catch (err) {
    return false;
  }
}

function generateVerificationCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 цифр
}

module.exports = { isValidFormat, domainCanReceiveMail, generateVerificationCode };
