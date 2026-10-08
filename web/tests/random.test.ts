import { describe, expect, it } from 'vitest';
import {
  INVITE_ALPHABET,
  INVITE_CODE_LENGTH,
  TOPIC_ALPHABET,
  TOPIC_PREFIX,
  TOPIC_RANDOM_LENGTH,
  generateInviteCode,
  generateNtfyTopic,
  isValidTopic,
  normalizeInviteCode,
  randomString,
  resolveNtfyServer,
} from '@/lib/random';

describe('generateNtfyTopic', () => {
  it('is utm- plus 20 lowercase base32 characters', () => {
    for (let i = 0; i < 50; i++) {
      const topic = generateNtfyTopic();
      expect(topic.startsWith(TOPIC_PREFIX)).toBe(true);
      expect(topic).toHaveLength(TOPIC_PREFIX.length + TOPIC_RANDOM_LENGTH);
      expect(topic).toMatch(/^utm-[a-z2-7]{20}$/);
      expect(isValidTopic(topic)).toBe(true);
    }
  });

  it('does not repeat', () => {
    const topics = new Set(Array.from({ length: 200 }, () => generateNtfyTopic()));
    expect(topics.size).toBe(200);
  });
});

describe('generateInviteCode', () => {
  it('is 10 characters from the unambiguous uppercase alphabet', () => {
    expect(INVITE_ALPHABET).not.toMatch(/[01OI]/);
    for (let i = 0; i < 50; i++) {
      const code = generateInviteCode();
      expect(code).toHaveLength(INVITE_CODE_LENGTH);
      for (const ch of code) expect(INVITE_ALPHABET).toContain(ch);
    }
  });
});

describe('randomString', () => {
  it('discards bytes that would bias the distribution', () => {
    // Alphabet of 10: bytes >= 250 are discarded, so 255 and 250 are skipped.
    const queue = [255, 250, 3, 7, 12];
    const fill = (bytes: Uint8Array) => {
      for (let i = 0; i < bytes.length; i++) bytes[i] = queue.length ? queue.shift()! : 0;
      return bytes;
    };
    expect(randomString('0123456789', 3, fill)).toBe('372'); // 3, 7, 12 % 10 = 2
  });

  it('rejects degenerate alphabets', () => {
    expect(() => randomString('a', 5)).toThrow();
    expect(TOPIC_ALPHABET).toHaveLength(32);
  });
});

describe('normalizeInviteCode', () => {
  it('trims, uppercases and drops separators', () => {
    expect(normalizeInviteCode(' abcd-efgh 23 ')).toBe('ABCDEFGH23');
  });

  it('rejects empty, symbols and overlong input', () => {
    expect(normalizeInviteCode('')).toBeNull();
    expect(normalizeInviteCode('ab*c')).toBeNull();
    expect(normalizeInviteCode('A'.repeat(33))).toBeNull();
    expect(normalizeInviteCode('x&or=1')).toBeNull();
  });
});

describe('isValidTopic', () => {
  it('accepts ntfy-safe names only', () => {
    expect(isValidTopic('my_topic-1')).toBe(true);
    expect(isValidTopic('')).toBe(false);
    expect(isValidTopic('has space')).toBe(false);
    expect(isValidTopic('a/b')).toBe(false);
    expect(isValidTopic('x'.repeat(65))).toBe(false);
  });
});

describe('resolveNtfyServer', () => {
  it('defaults to ntfy.sh and accepts a valid https override', () => {
    expect(resolveNtfyServer(undefined)).toBe('https://ntfy.sh');
    expect(resolveNtfyServer(' https://ntfy.example.com/ ')).toBe('https://ntfy.example.com');
  });

  it('ignores http, credentials and garbage', () => {
    expect(resolveNtfyServer('http://ntfy.example.com')).toBe('https://ntfy.sh');
    expect(resolveNtfyServer('https://u:p@ntfy.example.com')).toBe('https://ntfy.sh');
    expect(resolveNtfyServer('nope')).toBe('https://ntfy.sh');
  });
});
