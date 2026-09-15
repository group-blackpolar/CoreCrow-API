import nodemailer from "nodemailer";
const transport = process.env.SMTP_URL
    ? nodemailer.createTransport(process.env.SMTP_URL)
    : undefined;
export async function verifyIdentityMailTransport() {
    if (!transport || !process.env.MAIL_FROM)
        return "not_configured";
    try {
        await transport.verify();
        return "available";
    }
    catch {
        return "unavailable";
    }
}
export async function sendIdentityMail(to, subject, url) {
    if (!transport || !process.env.MAIL_FROM)
        throw new Error("Identity email delivery unavailable");
    await transport.sendMail({
        from: process.env.MAIL_FROM,
        to,
        subject,
        text: `${subject}\n\n${url}\n\nIf you did not request this, ignore this email.`,
    });
}
