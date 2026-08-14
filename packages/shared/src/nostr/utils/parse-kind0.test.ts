import { parseKind0Content } from './parse-kind0';

describe('parseKind0Content', () => {
  it('parses a standard kind-0 content string', () => {
    const content = JSON.stringify({
      name: 'Alice',
      picture: 'https://img.test/a.jpg',
      about: 'Streamer',
      nip05: 'alice@example.com',
      banner: 'https://img.test/banner.jpg',
      website: 'https://alice.live',
      lud16: 'alice@getalby.com',
    });
    const result = parseKind0Content(content);
    expect(result).toMatchObject({
      name: 'Alice',
      picture: 'https://img.test/a.jpg',
      about: 'Streamer',
      nip05: 'alice@example.com',
      banner: 'https://img.test/banner.jpg',
      website: 'https://alice.live',
      lud16: 'alice@getalby.com',
    });
  });

  it('falls back to display_name when name is missing', () => {
    const content = JSON.stringify({ display_name: 'Bob' });
    const result = parseKind0Content(content);
    expect(result?.name).toBe('Bob');
  });

  it('defaults name to Guest when both name and display_name are missing', () => {
    const content = JSON.stringify({ picture: 'pic.jpg' });
    const result = parseKind0Content(content);
    expect(result?.name).toBe('Guest');
  });

  it('returns null for invalid JSON', () => {
    expect(parseKind0Content('not json')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseKind0Content('')).toBeNull();
  });

  it('sets picture to null when missing', () => {
    const content = JSON.stringify({ name: 'Alice' });
    const result = parseKind0Content(content);
    expect(result?.picture).toBeNull();
  });

  it('leaves optional fields undefined when missing', () => {
    const content = JSON.stringify({ name: 'Alice' });
    const result = parseKind0Content(content);
    expect(result?.about).toBeUndefined();
    expect(result?.nip05).toBeUndefined();
    expect(result?.banner).toBeUndefined();
    expect(result?.website).toBeUndefined();
    expect(result?.lud16).toBeUndefined();
  });
});
