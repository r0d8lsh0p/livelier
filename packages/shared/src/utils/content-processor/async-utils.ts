/**
 * Utility functions for asynchronous content processing
 */

/**
 * Asynchronous version of String.replace that supports async callbacks
 * 
 * @param str The string to process
 * @param regex The regular expression to match
 * @param asyncFn The async callback function
 * @returns The processed string
 */
export async function asyncStringReplace(
  str: string,
  regex: RegExp,
  asyncFn: (...args: any[]) => Promise<string>
): Promise<string> {
  // Find all matches and their positions
  const matches: Array<{
    match: string;
    index: number;
    groups: string[];
  }> = [];
  
  // Create a copy of the regex to ensure we get all matches
  const regexWithGlobal = new RegExp(regex, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  
  let match;
  while ((match = regexWithGlobal.exec(str)) !== null) {
    matches.push({
      match: match[0],
      index: match.index,
      groups: match.slice(1)
    });
  }
  
  // If no matches, return the original string
  if (matches.length === 0) {
    return str;
  }
  
  // Process all matches concurrently
  const replacements = await Promise.all(
    matches.map(async ({ match, index, groups }) => {
      const replacement = await asyncFn(match, ...groups, index, str);
      return {
        start: index,
        end: index + match.length,
        replacement
      };
    })
  );
  
  // Apply replacements in reverse order to avoid index shifting
  let result = str;
  replacements
    .sort((a, b) => b.start - a.start)
    .forEach(({ start, end, replacement }) => {
      result = result.substring(0, start) + replacement + result.substring(end);
    });
  
  return result;
}
