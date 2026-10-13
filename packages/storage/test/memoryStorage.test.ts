import { MemoryStorage } from '../src/memoryStorage.ts';
import { storageContract } from './storageContract.ts';

storageContract('memory', () => new MemoryStorage());
