import { describe, it, expect } from 'vitest';

// Test auth validation logic (isolated from bcrypt/jwt/database)

describe('Auth validation', () => {
  function validateUsername(username) {
    if (!username) return 'Username is required';
    if (username.length < 3 || username.length > 32) return 'Username must be 3-32 characters';
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) return 'Username can only contain letters, numbers, underscores and hyphens';
    return null;
  }

  function validatePassword(password) {
    if (!password) return 'Password is required';
    if (password.length < 6) return 'Password must be at least 6 characters';
    return null;
  }

  describe('username validation', () => {
    it('should accept valid usernames', () => {
      expect(validateUsername('admin')).toBeNull();
      expect(validateUsername('user_name')).toBeNull();
      expect(validateUsername('user-name')).toBeNull();
      expect(validateUsername('User123')).toBeNull();
      expect(validateUsername('abc')).toBeNull(); // min length
    });

    it('should reject empty username', () => {
      expect(validateUsername('')).toBeTruthy();
      expect(validateUsername(null)).toBeTruthy();
      expect(validateUsername(undefined)).toBeTruthy();
    });

    it('should reject too-short usernames', () => {
      expect(validateUsername('ab')).toContain('3-32');
    });

    it('should reject too-long usernames', () => {
      expect(validateUsername('a'.repeat(33))).toContain('3-32');
    });

    it('should reject special characters', () => {
      expect(validateUsername('user name')).toBeTruthy(); // space
      expect(validateUsername('user@name')).toBeTruthy(); // @
      expect(validateUsername('user.name')).toBeTruthy(); // period
      expect(validateUsername('<script>')).toBeTruthy(); // XSS
    });
  });

  describe('password validation', () => {
    it('should accept valid passwords', () => {
      expect(validatePassword('password123')).toBeNull();
      expect(validatePassword('123456')).toBeNull(); // min length
      expect(validatePassword('a very long secure password!!!')).toBeNull();
    });

    it('should reject empty passwords', () => {
      expect(validatePassword('')).toBeTruthy();
      expect(validatePassword(null)).toBeTruthy();
    });

    it('should reject too-short passwords', () => {
      expect(validatePassword('12345')).toContain('6 characters');
    });
  });
});
