export interface ExternalDepositIntent {
  sourceWallet: string;
  destinationWallet: string;
  mint: string;
  amount: string;
}

/** Preparation and broadcast only. Settlement is owned by the existing deposit ingester. */
export interface ExternalDepositGateway {
  prepare(intent: ExternalDepositIntent): Promise<{ transaction: string }>;
  submit(intent: ExternalDepositIntent, transaction: string): Promise<{ signature: string; submission: 'submitted' | 'unknown' }>;
}

export class ExternalDepositError extends Error {
  constructor(readonly code: string, message: string, readonly status = 422) { super(message); }
}
