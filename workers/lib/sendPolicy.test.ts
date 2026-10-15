import { describe, expect, it } from "vitest";
import { reserveDailySend, SEND_WINDOW_MS } from "./sendPolicy";

// Serialized transactions model the storage contract, with yielding reads to
// expose any accidental check outside the transaction.
function durableStorage() {
  const values = new Map<string, unknown>();
  let tail = Promise.resolve();
  const storage = {
    transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
      const run = tail.then(() => callback({
        get: async (key: string) => { await Promise.resolve(); return values.get(key); },
        put: async (key: string, value: unknown) => { values.set(key, value); },
      }));
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
  return storage as unknown as Pick<DurableObjectStorage, "transaction">;
}

describe("durable account send admission", () => {
  it("admits only one simultaneous request and preserves the window across later calls", async () => {
    const storage = durableStorage();
    const attempts = await Promise.all(Array.from({ length: 20 }, () => reserveDailySend(storage, 1_000)));
    expect(attempts.filter(r => r.ok)).toHaveLength(1);
    expect(await reserveDailySend(storage, 1_001)).toEqual({ ok: false, retryAt: 1_000 + SEND_WINDOW_MS });
  });
  it("resets at exactly 24 hours, independently for different accounts", async () => {
    const account = durableStorage(), other = durableStorage();
    expect((await reserveDailySend(account, 0)).ok).toBe(true);
    expect((await reserveDailySend(other, 1)).ok).toBe(true);
    expect((await reserveDailySend(account, SEND_WINDOW_MS - 1)).ok).toBe(false);
    expect((await reserveDailySend(account, SEND_WINDOW_MS)).ok).toBe(true);
  });
  it("does not admit a send when storage fails", async () => {
    const storage = { transaction: async () => { throw new Error("unavailable"); } } as never;
    await expect(reserveDailySend(storage)).rejects.toThrow("unavailable");
  });
});
