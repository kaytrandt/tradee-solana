import { decimalString, type Asset } from './asset.js';

/** Pending chain scaling becomes effective even between catalog refreshes. */
export function effectiveQuantityMultiplier(asset: Pick<Asset, 'multiplier' | 'pendingMultiplier' | 'pendingMultiplierActivationAt'>, at = new Date()) {
  return asset.pendingMultiplier != null && asset.pendingMultiplierActivationAt != null && asset.pendingMultiplierActivationAt <= at
    ? asset.pendingMultiplier : asset.multiplier ?? decimalString('1');
}
