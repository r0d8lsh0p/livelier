import { ContentProcessor, ContentReplacement, ContentToken, ProcessedContent, ProcessingOptions } from './types';
import type { ChatMessage } from '../../nostr/services/nostr-chat.service';
import { getAllProcessors, getProcessorsByIds } from './registry';
import { asyncStringReplace } from './async-utils';

/**
 * Process content using registered processors asynchronously
 * 
 * @param content The text content to process
 * @param options Processing options
 * @returns Promise resolving to the processed content with tokens and replacements
 */
export async function processContent(
  content: string,
  options: ProcessingOptions = {}
): Promise<ProcessedContent> {
  // Determine which processors to use
  const activeProcessors = options.processors 
    ? getProcessorsByIds(options.processors)
    : getAllProcessors();
  
  // Filter to only include processors with patterns (in-content processors)
  const inContentProcessors = activeProcessors.filter(p => p.pattern);
  
  // Sort by priority if specified
  inContentProcessors.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  
  // Initialize with a single text token containing the entire content
  let tokens: ContentToken[] = [
    { type: 'text', value: content }
  ];
  
  const replacements: ContentReplacement[] = [];
  
  // Apply each processor sequentially
  for (const processor of inContentProcessors) {
    if (!processor.pattern) continue;
    
    // Process tokens array
    const newTokens: ContentToken[] = [];
    
    for (const token of tokens) {
      // Only process text tokens
      if (token.type !== 'text') {
        newTokens.push(token);
        continue;
      }
      
      // Create a new regex with the global flag to find all matches
      const regexWithGlobal = new RegExp(
        processor.pattern, 
        processor.pattern.flags.includes('g') ? processor.pattern.flags : processor.pattern.flags + 'g'
      );
      
      // Find all matches in this text token
      const matches: Array<{
        match: string;
        index: number;
        groups: string[];
      }> = [];
      
      let match;
      while ((match = regexWithGlobal.exec(token.value)) !== null) {
        matches.push({
          match: match[0],
          index: match.index,
          groups: match.slice(1)
        });
      }
      
      // If no matches, keep the token as is
      if (matches.length === 0) {
        newTokens.push(token);
        continue;
      }
      
      // Process matches and split the token
      let lastIndex = 0;
      
      for (const { match, index, groups } of matches) {
        // Add text before the match if any
        if (index > lastIndex) {
          newTokens.push({
            type: 'text',
            value: token.value.substring(lastIndex, index)
          });
        }
        
        // Process the match
        const result = await processor.process(
          match, 
          ...groups, 
          index, 
          token.value, 
          options.context
        );
        
        // Create a token for the processed match
        if (result.metadata) {
          // Add a specialized token
          newTokens.push({
            type: result.metadata.type || 'unknown',
            value: result.result,
            metadata: result.metadata
          });
          
          // Also add to replacements for backward compatibility
          replacements.push({
            type: result.metadata.type || 'unknown',
            originalText: match,
            displayText: result.result,
            metadata: result.metadata,
            indices: [index, index + result.result.length] // Note: these indices may not be accurate after multiple replacements
          });
        } else {
          // Add as plain text if no metadata
          newTokens.push({
            type: 'text',
            value: result.result
          });
        }
        
        lastIndex = index + match.length;
      }
      
      // Add remaining text after the last match
      if (lastIndex < token.value.length) {
        newTokens.push({
          type: 'text',
          value: token.value.substring(lastIndex)
        });
      }
    }
    
    // Update tokens for the next processor
    tokens = newTokens;
  }
  
  // Generate the full text from tokens
  const processedText = tokens.map(token => token.value).join('');
  
  return {
    text: processedText,
    replacements,
    tokens
  };
}

/**
 * Process a message using message-level processors asynchronously
 * 
 * @param message The chat message to process
 * @param options Processing options
 * @returns Promise resolving to the processed message content
 */
export async function processMessage(
  message: any,
  options: ProcessingOptions = {}
): Promise<string> {
  // Determine which processors to use
  const activeProcessors = options.processors 
    ? getProcessorsByIds(options.processors)
    : getAllProcessors();
  
  // Find a processor that handles this message kind
  const processor = activeProcessors.find(p => p.messageKind === message.kind);
  
  if (processor) {
    const result = await processor.process(message, options.context);
    return result.result;
  }
  
  // If no processor found, return the original content or empty string if undefined
  // Use non-null assertion operator to tell TypeScript that we're handling undefined
  return (message.content || '') as string;
}

// No caching in the content processor as per requirements
