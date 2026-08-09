import { createHash } from "node:crypto";

import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  canonicalByteLength,
  decodePersistedStructuredJson,
  hashCanonicalBytes,
  ingestStructuredJson,
  StructuredMessageCodecError,
  type StructuredMessageSchema,
} from "@/src/server/structured-messages/structured-message-codec";

const knownSchema = z.object({
  blockSchemaVersion: z.literal(1),
  text: z.string(),
}).strict();
type Known = z.infer<typeof knownSchema>;

const schema: StructuredMessageSchema<Known> = {
  classify(value) {
    return value
      && typeof value === "object"
      && "blockSchemaVersion" in value
      && value.blockSchemaVersion !== 1
      ? "unknown-schema"
      : "known";
  },
  parse(value) {
    return knownSchema.parse(value);
  },
  visibleText(value) {
    return [value.text];
  },
};

const options = {
  maxCanonicalBytes: 64 * 1024,
  maxWireBytes: 32 * 1024,
  schema,
};

function expectCode(operation: () => unknown, code: StructuredMessageCodecError["code"]): void {
  expect(operation).toThrowError(expect.objectContaining({ code }));
}

describe("structured message raw ingress and JCS codec", () => {
  it("rejects duplicate names before ordinary JSON parsing can discard them", () => {
    expectCode(
      () => ingestStructuredJson('{"blockSchemaVersion":1,"text":"first","text":"last"}', options),
      "DUPLICATE_KEY",
    );
    expectCode(
      () => ingestStructuredJson('{"blockSchemaVersion":1,"te\\u0078t":"first","text":"last"}', options),
      "DUPLICATE_KEY",
    );
  });

  it("matches RFC 8785 number and UTF-16 property ordering vectors", () => {
    const vectorSchema: StructuredMessageSchema<Record<string, unknown>> = {
      classify: () => "known",
      parse: (value) => z.record(z.string(), z.unknown()).parse(value),
      visibleText: () => [],
    };
    const result = ingestStructuredJson(
      `{
        "numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],
        "\\ufb33":7,"€":5,"\\r":1,"😀":6,"ö":4,"1":2,"\\u0080":3
      }`,
      { ...options, schema: vectorSchema },
    );

    expect(Buffer.from(result.canonicalBytes).toString("utf8")).toBe(
      `{"\\r":1,"1":2,"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"":3,"ö":4,"€":5,"😀":6,"דּ":7}`,
    );
    expect(hashCanonicalBytes(result.canonicalBytes)).toBe(
      createHash("sha256").update(result.canonicalBytes).digest("hex"),
    );
  });

  it("rejects BOM, malformed UTF-8, lone surrogates, and negative zero", () => {
    expectCode(
      () => ingestStructuredJson("\uFEFF{\"blockSchemaVersion\":1,\"text\":\"ok\"}", options),
      "INVALID_I_JSON",
    );
    expectCode(
      () => ingestStructuredJson('{"blockSchemaVersion":1,"text":"\\ud800"}', options),
      "INVALID_I_JSON",
    );
    expectCode(
      () => ingestStructuredJson('{"blockSchemaVersion":1,"text":"ok","extra":-0}', options),
      "INVALID_I_JSON",
    );
    expectCode(
      () => ingestStructuredJson(Uint8Array.from([0xc3, 0x28]), options),
      "INVALID_I_JSON",
    );
    for (const raw of ["NaN", "Infinity", "-Infinity"]) {
      expectCode(() => ingestStructuredJson(raw, options), "INVALID_JSON");
    }
  });

  it("keeps raw wire and canonical domain byte limits independent at ±1", () => {
    const compact = '{"blockSchemaVersion":1,"text":"x"}';
    const padded = `${compact}${" ".repeat(10)}`;
    expect(ingestStructuredJson(padded, {
      ...options,
      maxWireBytes: Buffer.byteLength(padded),
    }).value.text).toBe("x");
    expectCode(
      () => ingestStructuredJson(`${padded} `, {
        ...options,
        maxWireBytes: Buffer.byteLength(padded),
      }),
      "WIRE_TOO_LARGE",
    );

    const accepted = ingestStructuredJson(compact, options);
    expect(canonicalByteLength(accepted.canonicalBytes)).toBe(Buffer.byteLength(compact));
    expect(ingestStructuredJson(compact, {
      ...options,
      maxCanonicalBytes: accepted.canonicalBytes.byteLength,
    }).value.text).toBe("x");
    expectCode(
      () => ingestStructuredJson(compact, {
        ...options,
        maxCanonicalBytes: accepted.canonicalBytes.byteLength - 1,
      }),
      "CANONICAL_TOO_LARGE",
    );
  });

  it("atomically validates all credential-visible text", () => {
    expectCode(
      () => ingestStructuredJson(
        '{"blockSchemaVersion":1,"text":"Authorization: Bearer exposed"}',
        options,
      ),
      "CREDENTIAL_CONTENT_REJECTED",
    );
    expectCode(
      () => ingestStructuredJson(
        '{"blockSchemaVersion":1,"text":"configured-value"}',
        { ...options, configuredCredentialValues: ["configured-value"] },
      ),
      "CREDENTIAL_CONTENT_REJECTED",
    );
    expect(ingestStructuredJson(
      '{"blockSchemaVersion":1,"text":"token: <redacted>"}',
      options,
    ).value.text).toBe("token: <redacted>");
  });

  it("separates persisted Known, UnknownSchema, and Invalid outcomes", () => {
    expect(decodePersistedStructuredJson(
      '{"blockSchemaVersion":1,"text":"known"}',
      options,
    )).toMatchObject({ kind: "known", value: { text: "known" } });
    expect(decodePersistedStructuredJson(
      '{"blockSchemaVersion":2,"future":"opaque"}',
      options,
    )).toEqual({ kind: "unknown-schema" });
    expect(decodePersistedStructuredJson(
      '{"blockSchemaVersion":1,"text":3}',
      options,
    )).toEqual({ kind: "invalid" });
  });
});
