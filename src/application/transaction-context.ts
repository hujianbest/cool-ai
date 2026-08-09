const transactionContextBrand: unique symbol = Symbol("TransactionContext");

export type TransactionContext = {
  readonly [transactionContextBrand]: true;
};

export function createTransactionContext(): TransactionContext {
  return Object.freeze({ [transactionContextBrand]: true });
}
