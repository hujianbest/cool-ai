import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const SERVER_ROOT = resolve(ROOT, "src");
const DIRECT_FACT_INSERT =
  /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+collaboration_thread_facts/iu;

describe("Thread Fact Store repository contract", () => {
  it("is the only product-code writer for collaboration_thread_facts", () => {
    const offenders = readdirSync(SERVER_ROOT, { recursive: true })
      .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".ts"))
      .map((entry) => resolve(SERVER_ROOT, entry))
      .filter((path) => !path.endsWith("thread-fact-store.ts"))
      .filter((path) => !relative(SERVER_ROOT, path).startsWith("migrations"))
      .filter((path) => DIRECT_FACT_INSERT.test(readFileSync(path, "utf8")))
      .map((path) => relative(ROOT, path).replaceAll("\\", "/"))
      .sort();

    expect(offenders).toEqual([]);
  });
});
