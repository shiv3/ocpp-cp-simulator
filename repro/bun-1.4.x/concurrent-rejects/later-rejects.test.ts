// Problem A, file 2: runs after file 1 in the same `bun test` process. Each test
// ends on a rejected `expect(...).rejects`; the report is how long it took.
import { expect, test } from "bun:test";

async function fails(): Promise<never> {
  throw new Error("boom");
}

for (let i = 0; i < 5; i++) {
  test(`rejects ${i}`, async () => {
    const t0 = performance.now();
    await expect(fails()).rejects.toThrow("boom");
    console.log(`rejects ${i}: ${(performance.now() - t0).toFixed(2)} ms`);
  });
}
