import nodemailer from "nodemailer";
const transport = process.env.SMTP_URL
  ? nodemailer.createTransport(process.env.SMTP_URL)
  : undefined;
export async function sendIdentityMail(
  to: string,
  subject: string,
  url: string,
) {
  if (!transport || !process.env.MAIL_FROM)
    throw new Error("Identity email delivery unavailable");
  await transport.sendMail({
    from: process.env.MAIL_FROM,
    to,
    subject,
    text: `${subject}\n\n${url}\n\nIf you did not request this, ignore this email.`,
  });
}
