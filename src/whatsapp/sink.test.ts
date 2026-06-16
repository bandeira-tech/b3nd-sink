import { assertEquals, assertRejects } from "@std/assert";
import { ErrorCode } from "@bandeira-tech/b3nd-core";
import {
  createWhatsAppSink,
  URI_INBOUND_PREFIX,
  URI_MESSAGES_PREFIX,
  URI_STATUS_PREFIX,
} from "./mod.ts";
import type { WhatsAppSendPayload } from "./mod.ts";

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

function mockFetch(
  responder: (req: RecordedCall) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const recorded: RecordedCall = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(recorded);
    return await responder(recorded);
  };
  return { fetch, calls };
}

const baseConfig = {
  phoneNumberId: "123456789",
  accessToken: "TOKEN",
  appSecret: "secret",
  verifyToken: "vt",
  baseUrl: "https://graph.test",
};

const textPayload: WhatsAppSendPayload = {
  message: { type: "text", text: { body: "hi" } },
};

function okResponse() {
  return new Response(
    JSON.stringify({
      messaging_product: "whatsapp",
      contacts: [{ input: "+15555550100", wa_id: "15555550100" }],
      messages: [{ id: "wamid.abc" }],
    }),
    { status: 200 },
  );
}

Deno.test("createWhatsAppSink: throws without phoneNumberId", () => {
  let threw = false;
  try {
    createWhatsAppSink({ ...baseConfig, phoneNumberId: "" });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("createWhatsAppSink: throws without accessToken", () => {
  let threw = false;
  try {
    createWhatsAppSink({ ...baseConfig, accessToken: "" });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("receive: posts to graph /<version>/<phoneId>/messages with bearer auth", async () => {
  const { fetch, calls } = mockFetch(() => okResponse());
  const sink = createWhatsAppSink({ ...baseConfig, fetch });

  const results = await sink.receive([
    [`${URI_MESSAGES_PREFIX}+15555550100`, textPayload],
  ]);

  assertEquals(results, [{ accepted: true }]);
  assertEquals(calls.length, 1);
  assertEquals(
    calls[0].url,
    "https://graph.test/v21.0/123456789/messages",
  );
  assertEquals(calls[0].method, "POST");
  assertEquals(calls[0].headers.get("Authorization"), "Bearer TOKEN");
  assertEquals(calls[0].headers.get("Content-Type"), "application/json");
  const body = JSON.parse(calls[0].body);
  assertEquals(body.messaging_product, "whatsapp");
  assertEquals(body.to, "+15555550100");
  assertEquals(body.type, "text");
  assertEquals(body.text, { body: "hi" });
});

Deno.test("receive: respects graphVersion override", async () => {
  const { fetch, calls } = mockFetch(() => okResponse());
  const sink = createWhatsAppSink({
    ...baseConfig,
    graphVersion: "v19.0",
    fetch,
  });
  await sink.receive([[`${URI_MESSAGES_PREFIX}+15555550100`, textPayload]]);
  assertEquals(
    calls[0].url,
    "https://graph.test/v19.0/123456789/messages",
  );
});

Deno.test("receive: forwards contextMessageId as context.message_id", async () => {
  const { fetch, calls } = mockFetch(() => okResponse());
  const sink = createWhatsAppSink({ ...baseConfig, fetch });
  await sink.receive([[
    `${URI_MESSAGES_PREFIX}+15555550100`,
    { ...textPayload, contextMessageId: "wamid.parent" },
  ]]);
  const body = JSON.parse(calls[0].body);
  assertEquals(body.context, { message_id: "wamid.parent" });
});

Deno.test("receive: forwards biz_opaque_callback_data when provided", async () => {
  const { fetch, calls } = mockFetch(() => okResponse());
  const sink = createWhatsAppSink({ ...baseConfig, fetch });
  await sink.receive([[
    `${URI_MESSAGES_PREFIX}+15555550100`,
    { ...textPayload, bizOpaqueCallbackData: "corr-1" },
  ]]);
  const body = JSON.parse(calls[0].body);
  assertEquals(body.biz_opaque_callback_data, "corr-1");
});

Deno.test("receive: unknown uri scheme refused without HTTP call", async () => {
  const { fetch, calls } = mockFetch(() => okResponse());
  const sink = createWhatsAppSink({ ...baseConfig, fetch });
  const [result] = await sink.receive([
    ["whatsapp://media/abc", textPayload],
  ]);
  assertEquals(result.accepted, false);
  assertEquals(result.errorDetail?.code, ErrorCode.INVALID_URI);
  assertEquals(calls.length, 0);
});

Deno.test("receive: empty recipient refused without HTTP call", async () => {
  const { fetch, calls } = mockFetch(() => okResponse());
  const sink = createWhatsAppSink({ ...baseConfig, fetch });
  const [result] = await sink.receive([[URI_MESSAGES_PREFIX, textPayload]]);
  assertEquals(result.accepted, false);
  assertEquals(result.errorDetail?.code, ErrorCode.INVALID_URI);
  assertEquals(calls.length, 0);
});

Deno.test("receive: missing message.type refused without HTTP call", async () => {
  const { fetch, calls } = mockFetch(() => okResponse());
  const sink = createWhatsAppSink({ ...baseConfig, fetch });
  const [result] = await sink.receive([[
    `${URI_MESSAGES_PREFIX}+15555550100`,
    {} as WhatsAppSendPayload,
  ]]);
  assertEquals(result.accepted, false);
  assertEquals(result.errorDetail?.code, ErrorCode.INVALID_SCHEMA);
  assertEquals(calls.length, 0);
});

Deno.test("receive: 401 surfaces as UNAUTHORIZED refusal", async () => {
  const { fetch } = mockFetch(() =>
    new Response(
      JSON.stringify({
        error: { message: "Invalid OAuth access token", code: 190 },
      }),
      { status: 401 },
    )
  );
  const sink = createWhatsAppSink({ ...baseConfig, fetch });
  const [result] = await sink.receive([
    [`${URI_MESSAGES_PREFIX}+15555550100`, textPayload],
  ]);
  assertEquals(result.accepted, false);
  assertEquals(result.errorDetail?.code, ErrorCode.UNAUTHORIZED);
  assertEquals(result.error, "Invalid OAuth access token");
});

Deno.test("receive: 400 surfaces as INVALID_SCHEMA refusal with meta detail", async () => {
  const { fetch } = mockFetch(() =>
    new Response(
      JSON.stringify({
        error: {
          message: "(#100) Param to is required",
          code: 100,
          error_subcode: 2494010,
          type: "OAuthException",
          fbtrace_id: "abc",
        },
      }),
      { status: 400 },
    )
  );
  const sink = createWhatsAppSink({ ...baseConfig, fetch });
  const [result] = await sink.receive([
    [`${URI_MESSAGES_PREFIX}+15555550100`, textPayload],
  ]);
  assertEquals(result.accepted, false);
  assertEquals(result.errorDetail?.code, ErrorCode.INVALID_SCHEMA);
  const details = result.errorDetail?.details as Record<string, unknown>;
  assertEquals(details.statusCode, 400);
  assertEquals(details.metaCode, 100);
  assertEquals(details.fbtraceId, "abc");
});

Deno.test("receive: 429 surfaces as STORAGE_ERROR refusal (documented line)", async () => {
  const { fetch } = mockFetch(() =>
    new Response(
      JSON.stringify({ error: { message: "rate limited", code: 4 } }),
      { status: 429 },
    )
  );
  const sink = createWhatsAppSink({ ...baseConfig, fetch });
  const [result] = await sink.receive([
    [`${URI_MESSAGES_PREFIX}+15555550100`, textPayload],
  ]);
  assertEquals(result.accepted, false);
  assertEquals(result.errorDetail?.code, ErrorCode.STORAGE_ERROR);
});

Deno.test("receive: fetch failure propagates (transport throws)", async () => {
  const fetch: typeof globalThis.fetch = () =>
    Promise.reject(new TypeError("network down"));
  const sink = createWhatsAppSink({ ...baseConfig, fetch });
  await assertRejects(
    () =>
      sink.receive([[`${URI_MESSAGES_PREFIX}+15555550100`, textPayload]]),
    TypeError,
    "network down",
  );
});

Deno.test("receive: 1:1 results across mixed batch", async () => {
  let n = 0;
  const { fetch } = mockFetch(() => {
    n++;
    if (n === 2) {
      return new Response(
        JSON.stringify({ error: { message: "bad", code: 100 } }),
        { status: 400 },
      );
    }
    return okResponse();
  });
  const sink = createWhatsAppSink({ ...baseConfig, fetch });
  const results = await sink.receive([
    [`${URI_MESSAGES_PREFIX}+15555550100`, textPayload],
    [`${URI_MESSAGES_PREFIX}+15555550101`, textPayload],
    [`${URI_MESSAGES_PREFIX}+15555550102`, textPayload],
  ]);
  assertEquals(results.length, 3);
  assertEquals(results[0].accepted, true);
  assertEquals(results[1].accepted, false);
  assertEquals(results[2].accepted, true);
});

Deno.test("read: throws (no read surface)", async () => {
  const sink = createWhatsAppSink({ ...baseConfig });
  await assertRejects(
    () => sink.read([`${URI_MESSAGES_PREFIX}+15555550100`]),
    Error,
    "no read surface",
  );
});

Deno.test("status: advertises three URI prefixes", async () => {
  const sink = createWhatsAppSink({ ...baseConfig });
  const status = await sink.status();
  assertEquals(status.status, "healthy");
  assertEquals(status.schema, [
    `${URI_MESSAGES_PREFIX}*`,
    `${URI_INBOUND_PREFIX}*`,
    `${URI_STATUS_PREFIX}*`,
  ]);
});
