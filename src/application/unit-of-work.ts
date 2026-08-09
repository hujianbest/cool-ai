import type { TransactionContext } from "@/src/application/transaction-context";

export interface UnitOfWork {
  run<T>(work: (transaction: TransactionContext) => T): T;
}
