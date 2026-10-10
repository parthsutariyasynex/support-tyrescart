import nodemailer from 'nodemailer';

// Outgoing email over SMTP. Configure in server/.env:
//   SMTP_HOST, SMTP_PORT (587 or 465), SMTP_USER, SMTP_PASS, MAIL_FROM ("support-tyrescart <no-reply@yourdomain.com>")
// Without SMTP_HOST, development prints the email to the server console instead (never in production).
const isProduction = process.env.NODE_ENV === 'production';

const transport = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: Number(process.env.SMTP_PORT ?? 587) === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    })
  : null;

export async function sendMail(mail: { to: string; subject: string; text: string; html: string }) {
  if (transport) {
    await transport.sendMail({ from: process.env.MAIL_FROM ?? process.env.SMTP_USER, ...mail });
    return;
  }
  if (isProduction) {
    console.error(`[mail] SMTP is not configured; could not send "${mail.subject}" to ${mail.to}`);
    return;
  }
  console.log(`\n[mail] SMTP not configured (dev): email to ${mail.to}\nSubject: ${mail.subject}\n${mail.text}\n`);
}
