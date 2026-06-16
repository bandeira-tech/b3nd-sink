import {
  type B3ndError,
  ErrorCode,
  type Output,
  type ProtocolInterfaceNode,
  type ReceiveResult,
  type StatusResult,
} from "@bandeira-tech/b3nd-core";
import {
  createWebhook,
  URI_INBOUND_PREFIX,
  URI_STATUS_PREFIX,
  type WhatsAppWebhook,
} from "./webhook.ts";
import type {
  WhatsAppErrorResponse,
  WhatsAppSendPayload,
  WhatsAppSendResponse,
  WhatsAppSinkConfig,
} from "./types.ts";

const DEFAULT_BASE_URL = "https://graph.facebook.com";
const DEFAULT_GRAPH_VERSION = "v21.0";
export const URI_MESSAGES_PREFIX = "whatsapp://messages/";
export { URI_INBOUND_PREFIX, URI_STATUS_PREFIX };

export interface WhatsAppSink extends ProtocolInterfaceNode {
  webhook: WhatsAppWebhook;
}

export function createWhatsAppSink(config: WhatsAppSinkConfig): WhatsAppSink {
  if (!config.phoneNumberId) {
    throw new Error("createWhatsAppSink: phoneNumberId is required");
  }
  if (!config.accessToken) {
    throw new Error("createWhatsAppSink: accessToken is required");
  }

  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const version = config.graphVersion ?? DEFAULT_GRAPH_VERSION;
  const fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  const authHeader = `Bearer ${config.accessToken}`;
  const endpoint = `${baseUrl}/${version}/${config.phoneNumberId}/messages`;

  const webhook = createWebhook({
    appSecret: config.appSecret,
    verifyToken: config.verifyToken,
  });

  async function sendOne(
    uri: string,
    payload: WhatsAppSendPayload,
  ): Promise<ReceiveResult> {
    if (!uri.startsWith(URI_MESSAGES_PREFIX)) {
      return refusal(ErrorCode.INVALID_URI, uri, `Unknown uri: ${uri}`);
    }
    const to = uri.slice(URI_MESSAGES_PREFIX.length);
    if (!to) {
      return refusal(
        ErrorCode.INVALID_URI,
        uri,
        "Missing recipient in uri (expected whatsapp://messages/<E164>)",
      );
    }
    if (!payload?.message?.type) {
      return refusal(
        ErrorCode.INVALID_SCHEMA,
        uri,
        "Payload missing `message.type`",
      );
    }

    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      ...payload.message,
    };
    if (payload.contextMessageId) {
      body.context = { message_id: payload.contextMessageId };
    }
    if (payload.bizOpaqueCallbackData) {
      body.biz_opaque_callback_data = payload.bizOpaqueCallbackData;
    }

    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Authorization": authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      await res.json().catch(() => null) as WhatsAppSendResponse | null;
      return { accepted: true };
    }

    const errBody = await res.json().catch(() => null) as
      | WhatsAppErrorResponse
      | null;
    const message = errBody?.error?.message ??
      `WhatsApp API responded ${res.status}`;
    return refusal(
      mapStatusToCode(res.status),
      uri,
      message,
      {
        statusCode: res.status,
        metaCode: errBody?.error?.code,
        metaSubcode: errBody?.error?.error_subcode,
        metaType: errBody?.error?.type,
        fbtraceId: errBody?.error?.fbtrace_id,
      },
    );
  }

  return {
    webhook,
    receive(msgs: Output[]): Promise<ReceiveResult[]> {
      return Promise.all(
        msgs.map(([uri, payload]) =>
          sendOne(uri, payload as WhatsAppSendPayload)
        ),
      );
    },

    read<T = unknown>(locators: string[]): Promise<Output<T>[]> {
      return Promise.reject(
        new Error(
          `whatsapp sink has no read surface (locators: ${
            locators.join(", ")
          })`,
        ),
      );
    },

    observe(): AsyncIterable<readonly string[]> {
      throw new Error(
        "whatsapp sink has no observe surface — wire webhook.parse output through your own bus",
      );
    },

    status(): Promise<StatusResult> {
      return Promise.resolve({
        status: "healthy",
        message:
          "whatsapp sink: egress + webhook parse; no live healthcheck in v0",
        schema: [
          `${URI_MESSAGES_PREFIX}*`,
          `${URI_INBOUND_PREFIX}*`,
          `${URI_STATUS_PREFIX}*`,
        ],
      });
    },
  };
}

function refusal(
  code: ErrorCode,
  uri: string,
  message: string,
  details?: unknown,
): ReceiveResult {
  const errorDetail: B3ndError = { code, message, uri, details };
  return { accepted: false, error: message, errorDetail };
}

function mapStatusToCode(status: number): ErrorCode {
  if (status === 401) return ErrorCode.UNAUTHORIZED;
  if (status === 403) return ErrorCode.FORBIDDEN;
  if (status === 404) return ErrorCode.NOT_FOUND;
  if (status === 409) return ErrorCode.CONFLICT;
  if (status === 400 || status === 422) return ErrorCode.INVALID_SCHEMA;
  // 429 lands here intentionally — see README's throw-vs-refusal section.
  return ErrorCode.STORAGE_ERROR;
}
