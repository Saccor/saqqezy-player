import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { IdbStorage } from '../src/idbStorage.ts';
import { storageContract } from './storageContract.ts';

storageContract('indexeddb', () => new IdbStorage(new IDBFactory()));
