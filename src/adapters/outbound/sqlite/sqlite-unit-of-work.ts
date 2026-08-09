import type { DatabaseSync } from "node:sqlite";

import {
  createTransactionContext,
  type TransactionContext,
} from "@/src/application/transaction-context";
import type { UnitOfWork } from "@/src/application/unit-of-work";
import { openDatabase } from "@/src/adapters/outbound/sqlite/connection";

const databasesByTransaction = new WeakMap<TransactionContext, DatabaseSync>();

export function sqliteDatabaseForTransaction(
  transaction: TransactionContext,
): DatabaseSync {
  const database = databasesByTransaction.get(transaction);
  if (!database) {
    throw new Error("TRANSACTION_CONTEXT_INVALID");
  }
  return database;
}

export class SqliteUnitOfWork implements UnitOfWork {
  constructor(private readonly databasePath: string) {}

  run<T>(work: (transaction: TransactionContext) => T): T {
    const database = openDatabase(this.databasePath);
    const transaction = createTransactionContext();
    let transactionStarted = false;
    try {
      database.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      databasesByTransaction.set(transaction, database);
      const result = work(transaction);
      database.exec("COMMIT");
      transactionStarted = false;
      return result;
    } catch (error) {
      if (transactionStarted) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // Preserve the domain failure that caused the rollback.
        }
      }
      throw error;
    } finally {
      databasesByTransaction.delete(transaction);
      database.close();
    }
  }
}
