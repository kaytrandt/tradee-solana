import assert from "node:assert/strict";
import test from "node:test";
import type { SolanaMintMetadataReader } from "../src/modules/assets/domain/xstocks-provider.js";
import { extractNullableDecimalField } from "../src/modules/assets/infrastructure/xstocks/exact-json-decimal.js";
import { XStocksHttpProvider, xStocksTokenLogoUrl } from "../src/modules/assets/infrastructure/xstocks/xstocks-http-provider.js";

test("xStocks token logos are derived from the suffixed provider symbol", () => {
  assert.equal(
    xStocksTokenLogoUrl("DELLx"),
    "https://xstocks-metadata.backed.fi/logos/tokens/DELLx.png",
  );
  assert.throws(() => xStocksTokenLogoUrl("DELL"), /Invalid xStocks symbol/);
});

test("exact provider decimals are retained as strings without Number arithmetic", () => {
  assert.equal(
    extractNullableDecimalField('{"quote":0.7117449181151588123456789}', "quote"),
    "0.7117449181151588123456789",
  );
  assert.equal(extractNullableDecimalField('{"quote":null}', "quote"), null);
});

test("xStocks DTOs are normalized and enriched without inferring tradability", async () => {
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/public/assets?")) {
      return Response.json({
        nodes: [
          {
            id: "provider-a",
            name: "Example xStock",
            symbol: "EXAMPLEx",
            underlyingSymbol: "EXAMPLE",
            underlying: {
              symbol: "EXAMPLE",
              isin: null,
              type: "Equity",
              listingCountry: "US",
            },
            logo: "https://example.invalid/logo.png",
            isTradingHalted: true,
            trading: {
              currency: "USD",
              isTradingHalted: true,
              openNow: false,
            },
            deployments: [
              { address: "EthereumMint", network: "Ethereum", supportsAtomicSwaps: true },
              { address: "SolanaMint", network: "Solana", supportsAtomicSwaps: false },
            ],
          },
        ],
        page: { currentPage: 0, hasNextPage: false },
      });
    }
    if (url.includes("/multiplier/history?network=Solana")) {
      return new Response('{"page":{"currentPage":0,"hasNextPage":false},"nodes":[{"id":"event-1","reason":"Dividend","multiplier":0.999999999999999999,"previousMultiplier":1,"activationDateTime":"2026-08-08T00:30:00.000Z"}]}', { status: 200 });
    }
    if (url.includes("/multiplier?network=Solana")) {
      return new Response('{"currentMultiplier":0.999999999999999999,"newMultiplier":1.01,"activationDateTime":"2026-09-02T00:30:00.000Z","reason":"Dividend"}', { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
  const mintReader: SolanaMintMetadataReader = {
    getDecimals: async (mint) => {
      assert.equal(mint, "SolanaMint");
      return 8;
    },
  };
  const observedAt = new Date("2026-08-31T00:00:00.000Z");
  const provider = new XStocksHttpProvider(mintReader, {
    fetch: fakeFetch,
    now: () => observedAt,
  });

  const assets = await provider.listSolanaAssets();

  assert.equal(assets.length, 1);
  assert.equal(assets[0]?.ticker, "EXAMPLE");
  assert.equal(assets[0]?.solanaMint, "SolanaMint");
  assert.equal(assets[0]?.decimals, 8);
  assert.equal(assets[0]?.currentPrice, null);
  assert.equal(assets[0]?.multiplier, "0.999999999999999999");
  assert.equal(assets[0]?.pendingMultiplier, "1.01");
  assert.equal(assets[0]?.pendingMultiplierActivationAt?.toISOString(), "2026-09-02T00:30:00.000Z");
  assert.equal(assets[0]?.tradingHalted, true);
  assert.equal(assets[0]?.marketOpen, false);
  assert.equal(assets[0]?.supportsAtomicSwaps, false);
  assert.equal(assets[0]?.corporateActions[0]?.previousMultiplier, "1");
  assert.equal(assets[0]?.priceChangeAbsolute, null);
  assert.equal(assets[0]?.available, true);
  assert.equal(calls.some((url) => url.includes("network=Solana")), true);
  assert.equal(calls.some((url) => url.endsWith("/price-data")), false);
});
