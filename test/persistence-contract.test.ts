import 'fake-indexeddb/auto';
import { InMemoryPersistence } from '../src/entities/PersistenceAdapter';
import { IndexedDbPersistence } from '../src/entities/IndexedDbPersistence';
import { runPersistenceContract } from './support/persistence-contract';

let n = 0;
runPersistenceContract('InMemoryPersistence', async () => new InMemoryPersistence());
runPersistenceContract('IndexedDbPersistence', async () =>
  IndexedDbPersistence.open({ databaseName: `contract-${++n}`, entityTypes: ['Invoice', 'Ledger', 'Empty'] }),
);
