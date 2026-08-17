import { ContentProcessor } from './types';

/**
 * Registry of content processors
 */
export const processors: Record<string, ContentProcessor> = {};

/**
 * Register a processor in the registry
 */
export function registerProcessor(processor: ContentProcessor): void {
  processors[processor.id] = processor;
}

/**
 * Get a processor by ID
 */
export function getProcessor(id: string): ContentProcessor | undefined {
  return processors[id];
}

/**
 * Get all registered processors
 */
export function getAllProcessors(): ContentProcessor[] {
  return Object.values(processors);
}

/**
 * Get processors by IDs
 */
export function getProcessorsByIds(ids: string[]): ContentProcessor[] {
  return ids.map(id => processors[id]).filter(Boolean);
}
