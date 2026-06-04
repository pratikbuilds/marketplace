import t from "tap";
import {
  extractSolanaAddress,
  getConfiguredSolanaCluster,
  getDefaultSolanaRpcUrl,
  getWalletAddresses,
  type WalletConfig,
} from "./solana-wallet.js";

await t.test("getConfiguredSolanaCluster", async (t) => {
  t.equal(getConfiguredSolanaCluster(undefined), "mainnet-beta");
  t.equal(getConfiguredSolanaCluster("devnet"), "devnet");
  t.equal(getConfiguredSolanaCluster("mainnet-beta"), "mainnet-beta");
  t.throws(
    () => getConfiguredSolanaCluster("testnet"),
    /Unsupported SOLANA_NETWORK "testnet"/,
  );
});

await t.test("getDefaultSolanaRpcUrl", async (t) => {
  t.equal(getDefaultSolanaRpcUrl("devnet"), "https://api.devnet.solana.com");
  t.equal(
    getDefaultSolanaRpcUrl("mainnet-beta"),
    "https://api.mainnet-beta.solana.com",
  );
});

await t.test("extractSolanaAddress", async (t) => {
  const config: WalletConfig = {
    solana: {
      "mainnet-beta": { address: "mainnet-sol-address" },
      devnet: { address: "devnet-sol-address" },
    },
  };

  t.equal(extractSolanaAddress(config, "devnet"), "devnet-sol-address");
  t.equal(extractSolanaAddress(config, "mainnet-beta"), "mainnet-sol-address");
  t.equal(
    extractSolanaAddress({
      solana: { "mainnet-beta": { address: "mainnet-sol-address" } },
    }),
    "mainnet-sol-address",
  );
  t.equal(
    extractSolanaAddress(
      { solana: { devnet: { address: "devnet-sol-address" } } },
      "mainnet-beta",
    ),
    null,
  );
});

await t.test("getWalletAddresses", async (t) => {
  const config: WalletConfig = {
    solana: {
      "mainnet-beta": { address: "mainnet-sol-address" },
    },
    evm: {
      base: { address: "0xbase" },
      polygon: { address: "0xpolygon" },
      monad: { address: "0xmonad" },
    },
  };

  t.same(getWalletAddresses(config), {
    solana: "mainnet-sol-address",
    base: "0xbase",
    polygon: "0xpolygon",
    monad: "0xmonad",
  });
});
