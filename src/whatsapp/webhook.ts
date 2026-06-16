import type { Output } from "@bandeira-tech/b3nd-core";
import type {
  NormalizedInbound,
  NormalizedInboundMessage,
  NormalizedInboundStatus,
  WebhookHandshakeQuery,
  WhatsAppInboundMessage,
  WhatsAppInboundStatus,
  WhatsAppWebhookEnvelope,
  WhatsAppWebhookValue,
} from "./types.ts";

export const URI_INBOUND_PREFIX = "whatsapp://inbound/";
export const URI_STATUS_PREFIX = "whatsapp://status/";

export interface WebhookConfig {
  appSecret?: string;
  verifyToken?: string;
}

export interface WhatsAppWebhook {
  /**
   * Handle Meta's GET handshake when registering a webhook URL. Returns
   * the challenge string to echo back, or null if the request did not
   * match the configured `verifyToken`.
   */
  verify(query: WebhookHandshakeQuery): string | null;

  /**
   * Validate the `X-Hub-Signature-256` header against the raw body.
   * Returns true on match. Throws if the sink wasn't configured with an
   * `appSecret` — silently accepting unsigned traffic is a footgun.
   */
  verifySignature(rawBody: string, signatureHeader: string | null): Promise<boolean>;

  /**
   * Verify signature, then parse the body into B3nd tuples.
   *
   *   inbound messages → [`whatsapp://inbound/<E164>`, NormalizedInboundMessage]
   *   delivery statuses → [`whatsapp://status/<wamid>`, NormalizedInboundStatus]
   *
   * Throws on signature mismatch (treated as a transport-layer attack
   * surface, not a domain refusal). Malformed JSON throws too.
   */
  parse(
    rawBody: string,
    signatureHeader: string | null,
  ): Promise<Output<NormalizedInbound>[]>;
}

export function createWebhook(config: WebhookConfig): WhatsAppWebhook {
  const { appSecret, verifyToken } = config;

  return {
    verify(query) {
      if (!verifyToken) {
        throw new Error(
          "whatsapp webhook: verify() requires a verifyToken in sink config",
        );
      }
      if (
        query["hub.mode"] === "subscribe" &&
        query["hub.verify_token"] === verifyToken &&
        typeof query["hub.challenge"] === "string"
      ) {
        return query["hub.challenge"];
      }
      return null;
    },

    async verifySignature(rawBody, signatureHeader) {
      if (!appSecret) {
        throw new Error(
          "whatsapp webhook: verifySignature() requires an appSecret in sink config",
        );
      }
      if (!signatureHeader) return false;
      // Header format: "sha256=<hex>"
      const m = /^sha256=([a-f0-9]+)$/i.exec(signatureHeader.trim());
      if (!m) return false;
      const expected = m[1].toLowerCase();
      const actual = await hmacSha256Hex(appSecret, rawBody);
      return timingSafeEqualHex(expected, actual);
    },

    async parse(rawBody, signatureHeader) {
      if (!appSecret) {
        throw new Error(
          "whatsapp webhook: parse() requires an appSecret in sink config",
        );
      }
      const ok = await this.verifySignature(rawBody, signatureHeader);
      if (!ok) {
        throw new Error("whatsapp webhook: signature verification failed");
      }
      const env = JSON.parse(rawBody) as WhatsAppWebhookEnvelope;
      return extractTuples(env);
    },
  };
}

function extractTuples(
  env: WhatsAppWebhookEnvelope,
): Output<NormalizedInbound>[] {
  const out: Output<NormalizedInbound>[] = [];
  if (!env?.entry) return out;
  for (const entry of env.entry) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = change.value;
      if (!value) continue;
      const to = value.metadata?.display_phone_number;
      for (const m of value.messages ?? []) {
        out.push([
          `${URI_INBOUND_PREFIX}${m.from}`,
          normalizeMessage(m, to),
        ]);
      }
      for (const s of value.statuses ?? []) {
        out.push([
          `${URI_STATUS_PREFIX}${s.id}`,
          normalizeStatus(s),
        ]);
      }
      // Other fields on `value` (errors at the value level, contacts
      // metadata) are not surfaced as tuples in v0 — see README open
      // questions.
      void (value as WhatsAppWebhookValue);
    }
  }
  return out;
}

function normalizeMessage(
  m: WhatsAppInboundMessage,
  to: string | undefined,
): NormalizedInboundMessage {
  return {
    kind: "message",
    messageId: m.id,
    from: m.from,
    to,
    timestamp: m.timestamp,
    type: m.type,
    text: m.text?.body,
    raw: m,
  };
}

function normalizeStatus(
  s: WhatsAppInboundStatus,
): NormalizedInboundStatus {
  return {
    kind: "status",
    messageId: s.id,
    status: s.status,
    timestamp: s.timestamp,
    recipient: s.recipient_id,
    bizOpaqueCallbackData: s.biz_opaque_callback_data,
    raw: s,
  };
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
