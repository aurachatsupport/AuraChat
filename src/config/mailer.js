const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true', // true для 465, false для 587 (STARTTLS)
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendVerificationEmail(to, code) {
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: 'Код подтверждения AuraChat',
    text: `Твой код подтверждения: ${code}\n\nОн действителен 15 минут. Если ты не регистрировался в AuraChat — просто проигнорируй это письмо.`,
    html: `
      <div style="font-family:sans-serif;padding:24px;background:#0e1420;color:#f2f3f5;border-radius:12px;max-width:400px;margin:0 auto;">
        <h2 style="color:#4EA4F5;margin:0 0 16px;">AuraChat</h2>
        <p style="margin:0 0 8px;">Твой код подтверждения:</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:8px;margin:16px 0;color:#fff;">${code}</div>
        <p style="color:#8891a8;font-size:12.5px;margin:0;">Код действителен 15 минут. Если ты не регистрировался в AuraChat — просто проигнорируй это письмо.</p>
      </div>
    `,
  });
}

module.exports = { transporter, sendVerificationEmail };
