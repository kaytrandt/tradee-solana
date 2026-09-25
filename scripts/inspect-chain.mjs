// Optional read-only mainnet check. No key, wallet connection, signing or send RPC.
import { readFile } from 'node:fs/promises';
const addresses = JSON.parse(await readFile(new URL('../onchain/addresses.json', import.meta.url), 'utf8'));
const url = process.argv[2] ?? 'https://api.mainnet-beta.solana.com';
const endpoint = new URL(url);
if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
  throw new Error('Use a public HTTPS RPC URL without credentials or query parameters.');
}
let id = 0;
async function rpc(method, params = []) {
  if (!['getGenesisHash', 'getMultipleAccounts'].includes(method)) throw new Error('Read-only RPC allowlist');
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Public RPC returned HTTP ${response.status}`);
  const body = await response.json();
  if (body.error || body.result === undefined) throw new Error('Public RPC could not complete this read');
  return body.result;
}
try {
  const genesis = await rpc('getGenesisHash');
  if (genesis !== addresses.genesisHash) throw new Error('RPC is not Solana mainnet-beta');
  // Native built-in programs are listed in addresses.json; inspect deployed programs here.
  const programs = Object.entries(addresses.programs).filter(([name]) => !['System', 'Compute Budget'].includes(name));
  const mints = [['USDC', addresses.settlementMint], ...Object.entries(addresses.exampleSunriseMints)];
  const entries = [...programs, ...mints];
  const result = await rpc('getMultipleAccounts', [entries.map(([, address]) => address),
    { encoding: 'base64', commitment: 'finalized', dataSlice: { offset: 0, length: 0 } }]);
  if (!Array.isArray(result.value) || result.value.length !== entries.length) throw new Error('Malformed RPC account response');
  const tokenOwners = [addresses.programs['SPL Token'], addresses.programs['Token-2022']];
  const checks = entries.map(([name, address], index) => {
    const account = result.value[index];
    const passed = Boolean(account && (index < programs.length ? account.executable === true
      : account.executable === false && tokenOwners.includes(account.owner)));
    return { name, address, exists: Boolean(account), executable: account?.executable ?? null,
      owner: account?.owner ?? null, passed };
  });
  console.log(JSON.stringify({ network: addresses.network, finalizedSlot: result.context.slot, checks }, null, 2));
  if (checks.some(check => !check.passed)) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Read-only chain inspection failed');
  process.exitCode = 1;
}
