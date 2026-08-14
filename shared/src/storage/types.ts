/**
 * Storage interfaces for the persistent caches. The adapter is a Node fs
 * implementation (see adapters/storage.ts).
 */

/**
 * Base storage adapter interface
 * Defines the low-level storage operations that must be implemented
 * by platform-specific adapters
 */
export interface IStorageAdapter {
  setItem(key: string, value: string): Promise<void>;
  getItem(key: string): Promise<string | null>;
  deleteItem(key: string): Promise<void>;
  isAvailable(): Promise<boolean>;
}

