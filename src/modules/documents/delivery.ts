import { fail } from "../../shared/errors.js";
import { mailConfigured, sendMailWithAttachment } from "../security/mail.js";

/**
 * Delivery channels. Secrets live only in the server environment. A channel that
 * is not configured reports so (503); it never simulates a successful send.
 */
export type ChannelState = "available" | "not_configured";
export const deliveryChannels = (): { email: ChannelState; whatsapp: ChannelState } => ({
  email: mailConfigured() ? "available" : "not_configured",
  whatsapp: whatsappFromEnvironment() ? "available" : "not_configured",
});

export type PdfFile = { filename: string; content: Buffer };

export async function deliverEmail(input: { to: string; subject: string; message: string; pdf: PdfFile }) {
  if (!mailConfigured()) fail(503, "EMAIL_NOT_CONFIGURED", "Email delivery is not configured for this environment");
  try {
    await sendMailWithAttachment({
      to: input.to,
      subject: input.subject,
      text: input.message,
      attachment: { filename: input.pdf.filename, content: input.pdf.content, contentType: "application/pdf" },
    });
  } catch {
    fail(502, "DELIVERY_FAILED", "The email could not be delivered");
  }
}

// ---------------------------------------------------------------------------
// WhatsApp: official Meta WhatsApp Business Cloud API only (never WhatsApp Web).
// ---------------------------------------------------------------------------

export interface WhatsAppProvider {
  /** Uploads the PDF and sends it to an E.164 number; resolves with the provider message id. */
  sendDocument(input: { to: string; message: string; reference: string; pdf: PdfFile }): Promise<string>;
}

type MetaConfiguration = {
  accessToken: string;
  phoneNumberId: string;
  apiVersion: string;
  /** Business-initiated messages outside the 24 h window require an approved template. */
  templateName?: string;
  templateLanguage: string;
};

export class MetaCloudWhatsAppProvider implements WhatsAppProvider {
  constructor(private readonly configuration: MetaConfiguration, private readonly request: typeof fetch = fetch) {}

  private url(path: string) {
    return `https://graph.facebook.com/${this.configuration.apiVersion}/${this.configuration.phoneNumberId}/${path}`;
  }

  private async call(path: string, init: RequestInit) {
    const response = await this.request(this.url(path), {
      ...init,
      headers: { authorization: `Bearer ${this.configuration.accessToken}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`WhatsApp provider responded ${response.status}`);
    return (await response.json()) as { id?: string; messages?: Array<{ id: string }> };
  }

  async sendDocument(input: { to: string; message: string; reference: string; pdf: PdfFile }) {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", "application/pdf");
    form.append("file", new Blob([new Uint8Array(input.pdf.content)], { type: "application/pdf" }), input.pdf.filename);
    const media = await this.call("media", { method: "POST", body: form });
    if (!media.id) throw new Error("WhatsApp media upload returned no id");
    const document = { id: media.id, filename: input.pdf.filename };
    const body = this.configuration.templateName
      ? {
          messaging_product: "whatsapp", to: input.to, type: "template",
          template: {
            name: this.configuration.templateName, language: { code: this.configuration.templateLanguage },
            components: [
              { type: "header", parameters: [{ type: "document", document }] },
              { type: "body", parameters: [{ type: "text", text: input.reference }, { type: "text", text: input.message.slice(0, 900) }] },
            ],
          },
        }
      : { messaging_product: "whatsapp", to: input.to, type: "document", document: { ...document, caption: input.message.slice(0, 1000) } };
    const sent = await this.call("messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return sent.messages?.[0]?.id ?? "";
  }
}

export function whatsappFromEnvironment(): WhatsAppProvider | undefined {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) return undefined;
  return new MetaCloudWhatsAppProvider({
    accessToken,
    phoneNumberId,
    apiVersion: process.env.WHATSAPP_API_VERSION ?? "v21.0",
    templateName: process.env.WHATSAPP_TEMPLATE_NAME || undefined,
    templateLanguage: process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? "es",
  });
}

/** E.164 digits only (country code required). Returns null when it cannot be a deliverable number. */
export function normalizeWhatsAppNumber(value: string): string | null {
  const digits = value.replace(/[\s().-]/g, "").replace(/^\+/, "");
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

export async function deliverWhatsApp(input: { to: string; message: string; reference: string; pdf: PdfFile }, provider = whatsappFromEnvironment()) {
  if (!provider) fail(503, "WHATSAPP_NOT_CONFIGURED", "WhatsApp Business is not configured for this environment");
  try {
    return await provider!.sendDocument(input);
  } catch {
    fail(502, "DELIVERY_FAILED", "The WhatsApp message could not be delivered");
  }
}
