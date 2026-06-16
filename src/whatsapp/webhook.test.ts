import { assertEquals, assertRejects } from "@std/assert";
import { createWhatsAppSink, URI_INBOUND_PREFIX, URI_STATUS_PREFIX } from "./mod.ts";
import type { NormalizedInbound } from "./mod.ts";

const config = {
  phoneNumberId: "123",
  accessToken: "TOKEN",
  appSecret: "secret",
  verifyToken: "vt",
};

async function signHex(secret: string, body: string): Promise<string> {
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

const sampleEnvelope = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA_ID",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: {
              display_phone_number: "15550001111",
              phone_number_id: "123",
            },
            contacts: [{ wa_id: "15555550100", profile: { name: "Ada" } }],
            messages: [
              {
                id: "wamid.INBOUND1",
                from: "15555550100",
                timestamp: "1700000000",
                type: "text",
                text: { body: "hi there" },
              },
            ],
            statuses: [
              {
                id: "wamid.OUT1",
                status: "delivered",
                timestamp: "1700000001",
                recipient_id: "15555550100",
                biz_opaque_callback_data: "corr-1",
              },
            ],
          },
        },
      ],
    },
  ],
};

Deno.test("webhook.verify: returns challenge on token match", () => {
  const sink = createWhatsAppSink(config);
  const out = sink.webhook.verify({
    "hub.mode": "subscribe",
    "hub.verify_token": "vt",
    "hub.challenge": "ch-1",
  });
  assertEquals(out, "ch-1");
});

Deno.test("webhook.verify: returns null on token mismatch", () => {
  const sink = createWhatsAppSink(config);
  const out = sink.webhook.verify({
    "hub.mode": "subscribe",
    "hub.verify_token": "wrong",
    "hub.challenge": "ch-1",
  });
  assertEquals(out, null);
});

Deno.test("webhook.verify: throws if verifyToken not configured", () => {
  const sink = createWhatsAppSink({ ...config, verifyToken: undefined });
  let threw = false;
  try {
    sink.webhook.verify({
      "hub.mode": "subscribe",
      "hub.verify_token": "vt",
      "hub.challenge": "ch-1",
    });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("webhook.verifySignature: true on valid sha256 signature", async () => {
  const sink = createWhatsAppSink(config);
  const body = JSON.stringify(sampleEnvelope);
  const sig = `sha256=${await signHex("secret", body)}`;
  assertEquals(await sink.webhook.verifySignature(body, sig), true);
});

Deno.test("webhook.verifySignature: false on wrong signature", async () => {
  const sink = createWhatsAppSink(config);
  const body = JSON.stringify(sampleEnvelope);
  assertEquals(
    await sink.webhook.verifySignature(body, "sha256=deadbeef"),
    false,
  );
});

Deno.test("webhook.verifySignature: false on missing header", async () => {
  const sink = createWhatsAppSink(config);
  assertEquals(await sink.webhook.verifySignature("{}", null), false);
});

Deno.test("webhook.verifySignature: false on malformed header", async () => {
  const sink = createWhatsAppSink(config);
  assertEquals(
    await sink.webhook.verifySignature("{}", "sha1=abcd"),
    false,
  );
});

Deno.test("webhook.verifySignature: throws if appSecret not configured", async () => {
  const sink = createWhatsAppSink({ ...config, appSecret: undefined });
  await assertRejects(
    () => sink.webhook.verifySignature("{}", "sha256=deadbeef"),
    Error,
    "requires an appSecret",
  );
});

Deno.test("webhook.parse: emits inbound + status tuples on valid signature", async () => {
  const sink = createWhatsAppSink(config);
  const body = JSON.stringify(sampleEnvelope);
  const sig = `sha256=${await signHex("secret", body)}`;
  const tuples = await sink.webhook.parse(body, sig);

  assertEquals(tuples.length, 2);

  const [inboundUri, inboundPayload] = tuples[0];
  assertEquals(inboundUri, `${URI_INBOUND_PREFIX}15555550100`);
  const msg = inboundPayload as Extract<NormalizedInbound, { kind: "message" }>;
  assertEquals(msg.kind, "message");
  assertEquals(msg.messageId, "wamid.INBOUND1");
  assertEquals(msg.from, "15555550100");
  assertEquals(msg.to, "15550001111");
  assertEquals(msg.type, "text");
  assertEquals(msg.text, "hi there");

  const [statusUri, statusPayload] = tuples[1];
  assertEquals(statusUri, `${URI_STATUS_PREFIX}wamid.OUT1`);
  const st = statusPayload as Extract<NormalizedInbound, { kind: "status" }>;
  assertEquals(st.kind, "status");
  assertEquals(st.messageId, "wamid.OUT1");
  assertEquals(st.status, "delivered");
  assertEquals(st.recipient, "15555550100");
  assertEquals(st.bizOpaqueCallbackData, "corr-1");
});

Deno.test("webhook.parse: throws on signature mismatch", async () => {
  const sink = createWhatsAppSink(config);
  const body = JSON.stringify(sampleEnvelope);
  await assertRejects(
    () => sink.webhook.parse(body, "sha256=deadbeef"),
    Error,
    "signature verification failed",
  );
});

Deno.test("webhook.parse: throws on malformed JSON even with valid signature", async () => {
  const sink = createWhatsAppSink(config);
  const body = "not-json";
  const sig = `sha256=${await signHex("secret", body)}`;
  await assertRejects(() => sink.webhook.parse(body, sig));
});

Deno.test("webhook.parse: empty envelope yields zero tuples", async () => {
  const sink = createWhatsAppSink(config);
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
  const sig = `sha256=${await signHex("secret", body)}`;
  const tuples = await sink.webhook.parse(body, sig);
  assertEquals(tuples.length, 0);
});

Deno.test("webhook.parse: ignores non-messages fields", async () => {
  const sink = createWhatsAppSink(config);
  const envelope = {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          { field: "account_review_update", value: { decision: "APPROVED" } },
        ],
      },
    ],
  };
  const body = JSON.stringify(envelope);
  const sig = `sha256=${await signHex("secret", body)}`;
  const tuples = await sink.webhook.parse(body, sig);
  assertEquals(tuples.length, 0);
});
