// Read-only AccountInfo/TokenAccount assertions only. No memory writes/closes.
// Schema: Jac0xb/lighthouse @ 4c579479c98635e419b1b167f08be02a71604a71.
export const LIGHTHOUSE_DEPOSIT_PROGRAM = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';

export function validLighthouseDepositPayload(data: Uint8Array): boolean {
  try {
    let offset = 0;
    const byte = () => { if (offset >= data.length) throw new Error('truncated'); return data[offset++]!; };
    const skip = (size: number) => { if (size > data.length - offset) throw new Error('truncated'); offset += size; };
    const tag = (max: number) => { if (byte() > max) throw new Error('tag'); };
    const option = (size: number) => { const present = byte(); if (present > 1) throw new Error('option'); if (present === 1) skip(size); };
    const compact = () => {
      let value = 0n;
      for (let index = 0; index < 10; index++) {
        const next = byte();
        if (index === 9 && next > 1) throw new Error('overflow');
        value |= BigInt(next & 0x7f) << BigInt(index * 7);
        if ((next & 0x80) === 0) return value;
      }
      throw new Error('overflow');
    };
    const instruction = byte();
    if (![5, 6, 9, 10].includes(instruction)) return false;
    tag(6); // Borsh enum ordinals, not the Rust display discriminants.
    const length = [6, 10].includes(instruction) ? compact() : 1n;
    if (length > BigInt(data.length - offset)) return false;
    // Structural count only; monetary assertion values are never converted to Number.
    for (let index = 0; index < Number(length); index++) {
      const field = byte();
      if (instruction === 5 || instruction === 6) {
        switch (field) {
          case 0: case 1: case 4: skip(8); tag(7); break;
          case 2: skip(32); tag(1); break;
          case 3: tag(8); tag(1); break;
          case 5: case 6: case 7: tag(1); tag(1); break;
          case 8: skip(32); compact(); compact(); break;
          default: return false;
        }
      } else {
        switch (field) {
          case 0: case 1: skip(32); tag(1); break;
          case 2: case 6: skip(8); tag(7); break;
          case 3: case 7: option(32); tag(1); break;
          case 4: skip(1); tag(7); break;
          case 5: option(8); tag(1); break;
          case 8: break;
          default: return false;
        }
      }
    }
    return offset === data.length;
  } catch { return false; }
}
