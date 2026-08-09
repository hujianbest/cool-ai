import type { TransactionContext } from "@/src/server/application/transaction-context";

export interface UnitOfWork {
  run<T>(work: (transaction: TransactionContext) => T): T;
}
