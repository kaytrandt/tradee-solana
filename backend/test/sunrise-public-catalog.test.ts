import assert from "node:assert/strict";
import test from "node:test";
import { sunrisePublicCatalog } from "../src/modules/assets/infrastructure/sunrise/sunrise-public-catalog.js";

function page(tokens: readonly Record<string, unknown>[]): string {
  const flight = `"initialTokens":${JSON.stringify(tokens)}`;
  return `<script>self.__next_f.push(${JSON.stringify([1, flight])})</script>`;
}

test("Sunrise public catalog extracts only identity-bound Solana tokens", () => {
  const solana = {
    id: "sunrise|solana|mint-1", horizonChainId: "solana", tokenAddress: "mint-1",
    tokenSymbol: "TEST", tokenIcon: "https://example.invalid/test.png", tokenDecimals: 6,
    platform: "svm", assetClass: "stock",
  };
  const ethereum = {
    id: "sunrise|ethereum|0x1", horizonChainId: "ethereum", tokenAddress: "0x1",
    tokenSymbol: "TEST", tokenIcon: null, tokenDecimals: 18, platform: "evm", assetClass: "stock",
  };
  assert.deepEqual(sunrisePublicCatalog(page([solana, ethereum])), [{
    address: "mint-1", symbol: "TEST", icon: "https://example.invalid/test.png", decimals: 6,
    chain: "solana", platform: "svm", assetClass: "stock",
  }]);
});

test("Sunrise public catalog rejects ambiguous and mismatched identities", () => {
  const token = {
    id: "sunrise|solana|different", horizonChainId: "solana", tokenAddress: "mint-1",
    tokenSymbol: "TEST", tokenIcon: null, tokenDecimals: 6, platform: "svm", assetClass: "stock",
  };
  assert.throws(() => sunrisePublicCatalog(page([token])), /identity mismatch/);
  assert.throws(() => sunrisePublicCatalog(`${page([{ ...token, id: "sunrise|solana|mint-1" }])}${page([{ ...token, id: "sunrise|solana|mint-1" }])}`), /ambiguous/);
});
