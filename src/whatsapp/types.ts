/**
 * WhatsApp Cloud API message body — the per-type payload sent to
 * `POST /{phone_number_id}/messages`. The sink fills in
 * `messaging_product` and `to`; everything else is pass-through.
 *
 * See https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 */
export type WhatsAppMessage =
  | { type: "text"; text: { body: string; preview_url?: boolean } }
  | {
    type: "template";
    template: {
      name: string;
      language: { code: string; policy?: string };
      // Provider's `components` array — kept opaque on purpose. Adding a
      // typed helper is one of the open questions in README.
      components?: Array<Record<string, unknown>>;
    };
  }
  | {
    type: "interactive";
    interactive: Record<string, unknown>;
  }
  | { type: "image"; image: { id?: string; link?: string; caption?: string } }
  | { type: "audio"; audio: { id?: string; link?: string } }
  | { type: "video"; video: { id?: string; link?: string; caption?: string } }
  | {
    type: "document";
    document: {
      id?: string;
      link?: string;
      caption?: string;
      filename?: string;
    };
  }
  | { type: "sticker"; sticker: { id?: string; link?: string } }
  | { type: "location"; location: Record<string, unknown> }
  | { type: "contacts"; contacts: Array<Record<string, unknown>> }
  | { type: "reaction"; reaction: { message_id: string; emoji: string } };

export interface WhatsAppSinkConfig {
  /** Meta phone-number-id used as the API path segment. */
  phoneNumberId: string;
  /** Graph API access token (System User or temporary). */
  accessToken: string;
  /**
   * App secret — required to verify inbound webhook signatures. Pass an
   * empty string if you build a send-only instance (webhook.verify and
   * webhook.parse will throw).
   */
  appSecret?: string;
  /**
   * Caller-chosen string returned during the GET handshake Meta does
   * when registering the webhook. Required if using `webhook.verify`.
   */
  verifyToken?: string;
  /** Graph API version segment. Defaults to `v21.0`. */
  graphVersion?: string;
  /** Override base URL — useful for tests against a mock server. */
  baseUrl?: string;
  /** Inject a fetch implementation — useful for tests. */
  fetch?: typeof globalThis.fetch;
}

/** Payload accepted by the sink for `whatsapp://messages/<E164>`. */
export interface WhatsAppSendPayload {
  message: WhatsAppMessage;
  /**
   * Optional reply context (Meta's `context.message_id`). Threading is
   * sink-supported; quoting policy stays with the caller.
   */
  contextMessageId?: string;
  /**
   * Optional biz_opaque_callback_data — Meta echoes this in the
   * delivery status webhook. Useful for correlating sends with statuses.
   */
  bizOpaqueCallbackData?: string;
}

/** Meta's success response for a send. */
export interface WhatsAppSendResponse {
  messaging_product: "whatsapp";
  contacts: Array<{ input: string; wa_id: string }>;
  messages: Array<{ id: string; message_status?: string }>;
}

/** Meta's error envelope. */
export interface WhatsAppErrorResponse {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_data?: { details?: string; messaging_product?: string };
    fbtrace_id?: string;
  };
}

/* ── Webhook shapes ───────────────────────────────────────────────── */

/** Raw shape Meta POSTs to the webhook endpoint. Partial — we only type
 * the fields we read. */
export interface WhatsAppWebhookEnvelope {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: WhatsAppWebhookValue;
    }>;
  }>;
}

export interface WhatsAppWebhookValue {
  messaging_product?: "whatsapp";
  metadata?: {
    display_phone_number?: string;
    phone_number_id?: string;
  };
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
  messages?: Array<WhatsAppInboundMessage>;
  statuses?: Array<WhatsAppInboundStatus>;
}

export interface WhatsAppInboundMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body?: string };
  image?: Record<string, unknown>;
  audio?: Record<string, unknown>;
  video?: Record<string, unknown>;
  document?: Record<string, unknown>;
  sticker?: Record<string, unknown>;
  reaction?: { message_id?: string; emoji?: string };
  interactive?: Record<string, unknown>;
  button?: Record<string, unknown>;
  location?: Record<string, unknown>;
  contacts?: Array<Record<string, unknown>>;
  context?: {
    from?: string;
    id?: string;
    forwarded?: boolean;
    referred_product?: Record<string, unknown>;
  };
  errors?: Array<Record<string, unknown>>;
}

export interface WhatsAppInboundStatus {
  id: string;
  status: "sent" | "delivered" | "read" | "failed" | string;
  timestamp: string;
  recipient_id: string;
  conversation?: Record<string, unknown>;
  pricing?: Record<string, unknown>;
  errors?: Array<Record<string, unknown>>;
  biz_opaque_callback_data?: string;
}

/** Normalized inbound message payload — flat, ergonomic for callers. */
export interface NormalizedInboundMessage {
  kind: "message";
  messageId: string;
  from: string;
  to?: string;
  timestamp: string;
  type: string;
  text?: string;
  /** The original Meta message object, untouched. */
  raw: WhatsAppInboundMessage;
}

/** Normalized inbound status payload. */
export interface NormalizedInboundStatus {
  kind: "status";
  messageId: string;
  status: WhatsAppInboundStatus["status"];
  timestamp: string;
  recipient: string;
  bizOpaqueCallbackData?: string;
  raw: WhatsAppInboundStatus;
}

export type NormalizedInbound =
  | NormalizedInboundMessage
  | NormalizedInboundStatus;

/** Result of `webhook.verify` on the GET handshake. */
export interface WebhookHandshakeQuery {
  "hub.mode"?: string;
  "hub.verify_token"?: string;
  "hub.challenge"?: string;
}
