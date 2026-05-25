import t from "tap";
import {
  extractAddresses,
  checkBalancesMeetMinimum,
  withRetry,
  BALANCE_CACHE_TTL_MS,
  type WalletConfig,
  type WalletBalances,
} from "./balances.js";

await t.test("BALANCE_CACHE_TTL_MS", async (t) => {
  t.equal(BALANCE_CACHE_TTL_MS, 60 * 1000, "should be 1 minute");
});

await t.test("extractAddresses", async (t) => {
  await t.test("returns nulls for null config", async (t) => {
    const result = extractAddresses(null);
    t.same(result, { solana: null, evm: null });
  });

  await t.test("returns nulls for empty config", async (t) => {
    const result = extractAddresses({});
    t.same(result, { solana: null, evm: null });
  });

  await t.test("extracts solana address", async (t) => {
    const config: WalletConfig = {
      solana: {
        "mainnet-beta": {
          address: "sol-address-123",
          key: "enc:secret",
        },
      },
    };
    const result = extractAddresses(config);
    t.equal(result.solana, "sol-address-123");
    t.equal(result.evm, null);
  });

  await t.test("extracts solana devnet address", async (t) => {
    const config: WalletConfig = {
      solana: {
        devnet: {
          address: "devnet-sol-address",
          key: "enc:secret",
        },
      },
    };
    const result = extractAddresses(config);
    t.equal(result.solana, "devnet-sol-address");
    t.equal(result.evm, null);
  });

  await t.test("extracts evm address from base", async (t) => {
    const config: WalletConfig = {
      evm: {
        base: {
          address: "0xabc123",
          key: "enc:secret",
        },
      },
    };
    const result = extractAddresses(config);
    t.equal(result.solana, null);
    t.equal(result.evm, "0xabc123");
  });

  await t.test("extracts both addresses", async (t) => {
    const config: WalletConfig = {
      solana: {
        "mainnet-beta": {
          address: "sol-address",
        },
      },
      evm: {
        base: {
          address: "0xevm-address",
        },
      },
    };
    const result = extractAddresses(config);
    t.equal(result.solana, "sol-address");
    t.equal(result.evm, "0xevm-address");
  });

  await t.test("handles missing nested properties", async (t) => {
    const config: WalletConfig = {
      solana: {},
      evm: {},
    };
    const result = extractAddresses(config);
    t.same(result, { solana: null, evm: null });
  });
});

await t.test("checkBalancesMeetMinimum", async (t) => {
  await t.test("returns false for null balances", async (t) => {
    t.equal(checkBalancesMeetMinimum(null, 0.001, 0.01), false);
  });

  await t.test("returns true when solana meets minimum", async (t) => {
    const balances: WalletBalances = {
      solana: { native: "0.01", usdc: "1.00", tokens: [] },
      base: { native: "0", usdc: "0", tokens: [] },
      polygon: { native: "0", usdc: "0", tokens: [] },
      monad: { native: "0", usdc: "0", tokens: [] },
    };
    t.equal(checkBalancesMeetMinimum(balances, 0.001, 0.01), true);
  });

  await t.test("returns false when solana below minimum sol", async (t) => {
    const balances: WalletBalances = {
      solana: { native: "0.0001", usdc: "1.00", tokens: [] },
      base: { native: "0", usdc: "0", tokens: [] },
      polygon: { native: "0", usdc: "0", tokens: [] },
      monad: { native: "0", usdc: "0", tokens: [] },
    };
    t.equal(checkBalancesMeetMinimum(balances, 0.001, 0.01), false);
  });

  await t.test("returns false when solana below minimum usdc", async (t) => {
    const balances: WalletBalances = {
      solana: { native: "0.01", usdc: "0.001", tokens: [] },
      base: { native: "0", usdc: "0", tokens: [] },
      polygon: { native: "0", usdc: "0", tokens: [] },
      monad: { native: "0", usdc: "0", tokens: [] },
    };
    t.equal(checkBalancesMeetMinimum(balances, 0.001, 0.01), false);
  });

  await t.test("returns true when base chain meets minimum", async (t) => {
    const balances: WalletBalances = {
      solana: { native: "0", usdc: "0", tokens: [] },
      base: { native: "0.01", usdc: "1.00", tokens: [] },
      polygon: { native: "0", usdc: "0", tokens: [] },
      monad: { native: "0", usdc: "0", tokens: [] },
    };
    t.equal(checkBalancesMeetMinimum(balances, 0.001, 0.01), true);
  });

  await t.test("returns true when polygon chain meets minimum", async (t) => {
    const balances: WalletBalances = {
      solana: { native: "0", usdc: "0", tokens: [] },
      base: { native: "0", usdc: "0", tokens: [] },
      polygon: { native: "0.5", usdc: "50.00", tokens: [] },
      monad: { native: "0", usdc: "0", tokens: [] },
    };
    t.equal(checkBalancesMeetMinimum(balances, 0.001, 0.01), true);
  });

  await t.test("returns true when monad chain meets minimum", async (t) => {
    const balances: WalletBalances = {
      solana: { native: "0", usdc: "0", tokens: [] },
      base: { native: "0", usdc: "0", tokens: [] },
      polygon: { native: "0", usdc: "0", tokens: [] },
      monad: { native: "1.0", usdc: "100.00", tokens: [] },
    };
    t.equal(checkBalancesMeetMinimum(balances, 0.001, 0.01), true);
  });

  await t.test("returns false when evm has usdc but no native", async (t) => {
    const balances: WalletBalances = {
      solana: { native: "0", usdc: "0", tokens: [] },
      base: { native: "0", usdc: "100.00", tokens: [] },
      polygon: { native: "0", usdc: "0", tokens: [] },
      monad: { native: "0", usdc: "0", tokens: [] },
    };
    // EVM chains require native > 0 for gas
    t.equal(checkBalancesMeetMinimum(balances, 0.001, 0.01), false);
  });

  await t.test("returns false when all chains are empty", async (t) => {
    const balances: WalletBalances = {
      solana: { native: "0", usdc: "0", tokens: [] },
      base: { native: "0", usdc: "0", tokens: [] },
      polygon: { native: "0", usdc: "0", tokens: [] },
      monad: { native: "0", usdc: "0", tokens: [] },
    };
    t.equal(checkBalancesMeetMinimum(balances, 0.001, 0.01), false);
  });

  await t.test("handles empty string balances", async (t) => {
    const balances: WalletBalances = {
      solana: { native: "", usdc: "", tokens: [] },
      base: { native: "", usdc: "", tokens: [] },
      polygon: { native: "", usdc: "", tokens: [] },
      monad: { native: "", usdc: "", tokens: [] },
    };
    t.equal(checkBalancesMeetMinimum(balances, 0.001, 0.01), false);
  });
});

await t.test("withRetry", async (t) => {
  await t.test("returns result on first success", async (t) => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        return "success";
      },
      { retries: 3, baseDelay: 10 },
    );
    t.equal(result, "success");
    t.equal(attempts, 1);
  });

  await t.test("retries on failure and succeeds", async (t) => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("temporary failure");
        }
        return "success after retries";
      },
      { retries: 3, baseDelay: 10 },
    );
    t.equal(result, "success after retries");
    t.equal(attempts, 3);
  });

  await t.test("throws after max retries exhausted", async (t) => {
    let attempts = 0;
    await t.rejects(
      withRetry(
        async () => {
          attempts++;
          throw new Error("persistent failure");
        },
        { retries: 2, baseDelay: 10 },
      ),
      { message: "persistent failure" },
    );
    t.equal(attempts, 3); // initial + 2 retries
  });

  await t.test("uses exponential backoff delays", async (t) => {
    const timestamps: number[] = [];
    let attempts = 0;
    await t.rejects(
      withRetry(
        async () => {
          timestamps.push(Date.now());
          attempts++;
          throw new Error("failure");
        },
        { retries: 2, baseDelay: 50 },
      ),
    );

    t.equal(attempts, 3);
    t.equal(timestamps.length, 3);
    // First delay: 50ms, second delay: 100ms
    const [t0, t1, t2] = timestamps as [number, number, number];
    const firstDelay = t1 - t0;
    const secondDelay = t2 - t1;

    // Allow some tolerance for timing
    t.ok(firstDelay >= 40, `first delay ${firstDelay}ms should be >= 40ms`);
    t.ok(firstDelay <= 80, `first delay ${firstDelay}ms should be <= 80ms`);
    t.ok(secondDelay >= 80, `second delay ${secondDelay}ms should be >= 80ms`);
    t.ok(
      secondDelay <= 150,
      `second delay ${secondDelay}ms should be <= 150ms`,
    );
  });

  await t.test("converts non-Error throws to Error", async (t) => {
    await t.rejects(
      withRetry(
        async () => {
          throw "string error"; // eslint-disable-line @typescript-eslint/only-throw-error -- testing non-Error throw conversion
        },
        { retries: 0, baseDelay: 10 },
      ),
      { message: "string error" },
    );
  });

  await t.test("succeeds on second attempt", async (t) => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error("first attempt fails");
        }
        return "second attempt succeeds";
      },
      { retries: 3, baseDelay: 10 },
    );
    t.equal(result, "second attempt succeeds");
    t.equal(attempts, 2);
  });

  await t.test("respects retries=0 (no retries)", async (t) => {
    let attempts = 0;
    await t.rejects(
      withRetry(
        async () => {
          attempts++;
          throw new Error("immediate failure");
        },
        { retries: 0, baseDelay: 10 },
      ),
    );
    t.equal(attempts, 1);
  });
});
