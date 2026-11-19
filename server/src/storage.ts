// Where the app keeps its data (docs/decisions/0013): MongoDB when MONGODB_URI is set, memory
// otherwise. The repository interfaces are the same either way (docs/decisions/0009).
import type { Repositories } from './app';
import { type AppConfig, ConfigError } from './config';
import { connectMongo } from './repositories/mongo/models';
import { MongoPasswordResetRepository } from './repositories/mongo/password-resets';
import { MongoPendingSignUpRepository } from './repositories/mongo/pending-sign-ups';
import { MongoTransactionRepository } from './repositories/mongo/transactions';
import { MongoUserRepository } from './repositories/mongo/users';
import { InMemoryPasswordResetRepository } from './repositories/password-resets';
import { InMemoryPendingSignUpRepository } from './repositories/pending-sign-ups';
import { InMemoryTransactionRepository } from './repositories/transactions';
import { InMemoryUserRepository } from './repositories/users';

export type Storage = {
  kind: 'mongodb' | 'memory';
  repositories: Repositories;
  /** Closes the database connection, if there is one. */
  close(): Promise<void>;
};

/** Empty in-memory repositories; everything is lost when the process ends. */
export function memoryStorage(): Storage {
  const users = new InMemoryUserRepository();
  return {
    kind: 'memory',
    repositories: {
      users,
      pendingSignUps: new InMemoryPendingSignUpRepository(),
      passwordResets: new InMemoryPasswordResetRepository(),
      // The transfer moves balances held in the user store.
      transactions: new InMemoryTransactionRepository(users),
    },
    close: async () => undefined,
  };
}

/** The MongoDB repositories, once the connection is open and every index exists. */
export async function mongoStorage(uri: string): Promise<Storage> {
  const { connection, models } = await connectMongo(uri);
  return {
    kind: 'mongodb',
    repositories: {
      users: new MongoUserRepository(models),
      pendingSignUps: new MongoPendingSignUpRepository(connection, models),
      passwordResets: new MongoPasswordResetRepository(connection, models),
      transactions: new MongoTransactionRepository(connection, models),
    },
    close: () => connection.close(),
  };
}

/**
 * MongoDB when the address is set. Without it, memory, except in production, where a restart
 * would lose every account: that is refused, naming the variable.
 */
export function openStorage(config: Pick<AppConfig, 'nodeEnv' | 'mongodbUri'>): Promise<Storage> {
  if (config.mongodbUri !== undefined) return mongoStorage(config.mongodbUri);
  if (config.nodeEnv === 'production') {
    return Promise.reject(
      new ConfigError([
        'MONGODB_URI must be set in production (the MongoDB connection string); without it every account is lost on restart',
      ]),
    );
  }
  return Promise.resolve(memoryStorage());
}
