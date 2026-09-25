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
export async function sendVerificationCodeMail(to, _name, code) {
    if (!transport || !process.env.MAIL_FROM)
        throw new Error("Identity email delivery unavailable");
    const subject = "Your Black Polar verification code";
    await transport.sendMail({
        from: process.env.MAIL_FROM,
        to,
        subject,
        text: [
            "BLACK POLAR",
            "",
            "Verify your email address",
            "",
            `Your verification code is: ${code}`,
            "",
            "This code expires in 10 minutes and can be used once.",
            "If you did not create a Black Polar account, you can ignore this email.",
        ].join("\n"),
        html: `<!doctype html>
<html lang="en"><body style="margin:0;background:#090b10;color:#f4f7fb;font-family:Arial,sans-serif">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#090b10;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#11151d;border:1px solid #283140;border-radius:16px;padding:36px">
        <tr><td style="font-size:13px;letter-spacing:3px;color:#9fb4d0;font-weight:700">BLACK POLAR</td></tr>
        <tr><td style="padding-top:24px;font-size:28px;line-height:1.2;font-weight:700">Verify your email address</td></tr>
        <tr><td style="padding-top:14px;color:#bdc7d5;font-size:16px;line-height:1.6">Enter this code in NORTH to finish creating your account.</td></tr>
        <tr><td style="padding:28px 0"><div style="background:#07090d;border:1px solid #35445a;border-radius:12px;padding:20px;text-align:center;font-family:Consolas,monospace;font-size:34px;font-weight:700;letter-spacing:10px;color:#ffffff">${code}</div></td></tr>
        <tr><td style="color:#9aa8ba;font-size:14px;line-height:1.6">This single-use code expires in 10 minutes. A new code invalidates the previous one.</td></tr>
        <tr><td style="padding-top:24px;color:#748196;font-size:12px;line-height:1.5">If you did not create a Black Polar account, you can safely ignore this email.</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`,
    });
}
function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
export async function sendOrganizationInvitationMail(to, organizationName, invitationUrl, expiresAt) {
    if (!transport || !process.env.MAIL_FROM)
        throw new Error("Identity email delivery unavailable");
    const safeOrganizationName = escapeHtml(organizationName);
    const safeUrl = escapeHtml(invitationUrl);
    const subject = `You're invited to ${organizationName} on NORTH`;
    await transport.sendMail({
        from: process.env.MAIL_FROM,
        to,
        subject,
        text: [
            "BLACK POLAR",
            "",
            `You have been invited to join ${organizationName} on NORTH.`,
            "",
            invitationUrl,
            "",
            `This single-use invitation expires ${expiresAt.toISOString()}.`,
            "Sign in with this email address and verify it before accepting.",
            "If you were not expecting this invitation, you can ignore this email.",
        ].join("\n"),
        html: `<!doctype html>
<html lang="en"><body style="margin:0;background:#090b10;color:#f4f7fb;font-family:Arial,sans-serif">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#090b10;padding:32px 16px"><tr><td align="center">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#11151d;border:1px solid #283140;border-radius:16px;padding:36px">
      <tr><td style="font-size:13px;letter-spacing:3px;color:#9fb4d0;font-weight:700">BLACK POLAR</td></tr>
      <tr><td style="padding-top:24px;font-size:28px;line-height:1.2;font-weight:700">Join ${safeOrganizationName}</td></tr>
      <tr><td style="padding-top:14px;color:#bdc7d5;font-size:16px;line-height:1.6">You have been invited to this organization on NORTH.</td></tr>
      <tr><td style="padding:28px 0"><a href="${safeUrl}" style="display:inline-block;background:#f4f7fb;color:#090b10;text-decoration:none;font-weight:700;padding:14px 22px;border-radius:10px">Accept invitation</a></td></tr>
      <tr><td style="color:#9aa8ba;font-size:14px;line-height:1.6">This link can be used once and expires ${escapeHtml(expiresAt.toISOString())}. Sign in with the invited email address.</td></tr>
      <tr><td style="padding-top:24px;color:#748196;font-size:12px;line-height:1.5">If you were not expecting this invitation, you can safely ignore this email.</td></tr>
    </table>
  </td></tr></table>
</body></html>`,
    });
}
export async function sendPreprovisionedAccountMail(to, temporaryPassword) {
    if (!transport || !process.env.MAIL_FROM)
        throw new Error("Identity email delivery unavailable");
    const northUrl = process.env.NORTH_PUBLIC_URL ?? "https://north.blackpolar.org";
    await transport.sendMail({
        from: process.env.MAIL_FROM,
        to,
        subject: "Your Black Polar account is ready",
        text: [
            "BLACK POLAR",
            "",
            "A platform administrator created your Black Polar account.",
            `Temporary password: ${temporaryPassword}`,
            "",
            "Request and confirm the verification code sent to this email, then sign in at:",
            northUrl,
            "",
            "You must replace this temporary password immediately after signing in.",
            "If you were not expecting this account, contact Black Polar support.",
        ].join("\n"),
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
