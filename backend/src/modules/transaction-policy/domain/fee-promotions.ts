export interface FeeBenefitContext { readonly userId: string; readonly referenceId: string }
export interface FeeBenefits {
  /** Discount on the base service fee, not percentage points of trade amount. */
  readonly serviceDiscountPercent: number;
  readonly rentWaived: boolean;
}
export interface FeePromotions {
  serviceDiscountPercent(userId: string): Promise<number>;
  benefits(context: FeeBenefitContext, hasRent: boolean): Promise<FeeBenefits>;
  release(context: FeeBenefitContext): Promise<void>;
}
export const NO_FEE_BENEFITS: FeeBenefits = { serviceDiscountPercent: 0, rentWaived: false };
