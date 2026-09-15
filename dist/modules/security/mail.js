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
export async function sendContactNotification(to, contact) {
    if (!transport || !process.env.MAIL_FROM)
        throw new Error("Contact email delivery unavailable");
    await transport.sendMail({
        from: process.env.MAIL_FROM,
        to,
        replyTo: contact.email,
        subject: "New Black Polar contact request",
        text: [
            "A new request was submitted through blackpolar.org.",
            "",
            `Name: ${contact.name}`,
            `Email: ${contact.email}`,
            `Organization: ${contact.organization}`,
            `Country / Region: ${contact.country}`,
            `Project: ${contact.project}`,
            `Language: ${contact.locale}`,
            `Submitted: ${contact.createdAt.toISOString()}`,
            "",
            "Message:",
            contact.message || "(No additional context provided)",
        ].join("\n"),
    });
}
