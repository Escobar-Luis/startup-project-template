import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => ({ text: strings.join("$?"), values })) as unknown as {
    (strings: TemplateStringsArray, ...values: unknown[]): { text: string; values: unknown[] };
    query: ReturnType<typeof import("vitest").vi.fn>;
    transaction: ReturnType<typeof import("vitest").vi.fn>;
  };
  return { tag };
});

vi.mock("@neondatabase/serverless", () => ({ neon: vi.fn(() => fake.tag) }));

import { neonStore } from "../src/worker/db";

describe("neonStore (real code, mocked driver)", () => {
  beforeEach(() => {
    fake.tag.query = vi.fn(async () => [{ calls: 1 }]);
    fake.tag.transaction = vi.fn(async (qs: unknown[]) => qs);
  });

  it("is null without DATABASE_URL", () => {
    expect(neonStore({})).toBeNull();
  });

  it("reserveCall upserts with the cap guard and params [day, cap]", async () => {
    const store = neonStore({ DATABASE_URL: "x" })!;
    expect(await store.reserveCall("2026-10-19", 200)).toBe(true);
    const [text, params] = fake.tag.query.mock.calls[0];
    expect(text).toContain("ON CONFLICT (day) DO UPDATE SET calls = llm_usage.calls + 1");
    expect(text).toContain("WHERE llm_usage.calls < $2");
    expect(text).toContain("RETURNING calls");
    expect(params).toEqual(["2026-10-19", 200]);
  });

  it("reserveCall is false when the upsert returns no row (at cap)", async () => {
    fake.tag.query = vi.fn(async () => []);
    expect(await neonStore({ DATABASE_URL: "x" })!.reserveCall("2026-10-19", 5)).toBe(false);
  });

  it("reserveCall with cap <= 0 is false and runs no query", async () => {
    const store = neonStore({ DATABASE_URL: "x" })!;
    expect(await store.reserveCall("2026-10-19", 0)).toBe(false);
    expect(await store.reserveCall("2026-10-19", -1)).toBe(false);
    expect(fake.tag.query).not.toHaveBeenCalled();
  });

  it("saveSubmission sets app.visitor first, in the same transaction as the insert", async () => {
    await neonStore({ DATABASE_URL: "x" })!.saveSubmission("v1", "in", "out", "demo");
    expect(fake.tag.transaction).toHaveBeenCalledTimes(1);
    const [first, second] = fake.tag.transaction.mock.calls[0][0] as { text: string; values: unknown[] }[];
    expect(first.text).toContain("set_config('app.visitor'");
    expect(first.values).toEqual(["v1"]);
    expect(second.text).toContain("INSERT INTO submissions");
    expect(second.values).toEqual(["v1", "in", "out", "demo"]);
  });
});
