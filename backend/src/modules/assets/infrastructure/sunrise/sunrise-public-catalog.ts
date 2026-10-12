/** Read only JSON data embedded by Sunrise's public server-rendered token page.
 * Never execute page scripts or resolve React references as code. */
export function sunrisePublicCatalog(html: string): Record<string, unknown>[] {
  if (html.length > 4_000_000) throw new Error('Sunrise public catalog is too large');
  let flight = '';
  for (const match of html.matchAll(/self\.__next_f\.push\((\[.*?\])\)<\/script>/gs)) {
    const chunk: unknown = JSON.parse(match[1]!);
    if (Array.isArray(chunk) && chunk[0] === 1 && typeof chunk[1] === 'string') flight += chunk[1];
  }
  const marker = '"initialTokens":';
  const start = flight.indexOf(marker);
  if (start < 0 || flight.indexOf(marker, start + marker.length) >= 0) throw new Error('Missing or ambiguous Sunrise public catalog');
  const data = flight.slice(start + marker.length).trimStart();
  if (!data.startsWith('[')) throw new Error('Invalid Sunrise public catalog');
  let depth = 0, quoted = false, escaped = false, end = -1;
  for (let i = 0; i < data.length; i++) {
    const char = data[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '[') depth++;
    else if (char === ']' && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0) throw new Error('Incomplete Sunrise public catalog');
  const tokens: unknown = JSON.parse(data.slice(0, end));
  if (!Array.isArray(tokens) || tokens.length === 0 || !tokens.every(object)) throw new Error('Invalid Sunrise public tokens');
  return tokens.filter(token => token.horizonChainId === 'solana').map(token => {
    if (token.id !== `sunrise|solana|${token.tokenAddress}`) {
      throw new Error('Sunrise public token identity mismatch');
    }
    return { address: token.tokenAddress, symbol: token.tokenSymbol, icon: token.tokenIcon,
      decimals: token.tokenDecimals, chain: token.horizonChainId, platform: token.platform, assetClass: token.assetClass };
  });
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
