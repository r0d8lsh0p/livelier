/**
 * Thin key-value facade over the storage adapter, used by the persistent
 * profile caches.
 */

import { IStorageAdapter } from './types';

import storageAdapter from './adapters/storage';

class SecureStorageService implements IStorageAdapter {
  private adapter = storageAdapter;

  /**
   * Basic adapter methods
   */
  
  async setItem(key: string, value: string): Promise<void> {
    return this.adapter.setItem(key, value);
  }
  
  async getItem(key: string): Promise<string | null> {
    return this.adapter.getItem(key);
  }
  
  async deleteItem(key: string): Promise<void> {
    return this.adapter.deleteItem(key);
  }
  
  async isAvailable(): Promise<boolean> {
    return this.adapter.isAvailable();
  }
  
}

// Export singleton instance
const secureStorageService = new SecureStorageService();
export default secureStorageService;
