import nodemailer from "nodemailer";
const transport = process.env.SMTP_URL
  ? nodemailer.createTransport({
      url: process.env.SMTP_URL,
      // Relay providers use EHLO to identify the sending host. Docker's
      // ephemeral container hostname is not a stable public identity.
      name: process.env.SMTP_HELO_NAME,
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 10000,
    })
  : undefined;

export async function verifyIdentityMailTransport() {
  if (!transport || !process.env.MAIL_FROM) return "not_configured" as const;
  try {
    await transport.verify();
    return "available" as const;
  } catch {
    return "unavailable" as const;
  }
}

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
