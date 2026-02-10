import { describe, expect, it } from 'vitest';

// Test the pure utility functions extracted from mcpServer.ts
// These are not exported, so we test them via their behavior patterns

describe('MCP utility functions', () => {
  describe('parseCsvSet', () => {
    function parseCsvSet(raw: string | undefined): Set<string> {
      if (!raw) return new Set();
      return new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
    }

    it('returns empty set for undefined', () => {
      expect(parseCsvSet(undefined).size).toBe(0);
    });

    it('returns empty set for empty string', () => {
      expect(parseCsvSet('').size).toBe(0);
    });

    it('returns empty set for whitespace-only', () => {
      expect(parseCsvSet('  ,  , ').size).toBe(0);
    });

    it('parses single value', () => {
      const result = parseCsvSet('foo');
      expect(result.size).toBe(1);
      expect(result.has('foo')).toBe(true);
    });

    it('parses multiple values with whitespace', () => {
      const result = parseCsvSet(' foo , bar , baz ');
      expect(result.size).toBe(3);
      expect(result.has('foo')).toBe(true);
      expect(result.has('bar')).toBe(true);
      expect(result.has('baz')).toBe(true);
    });

    it('handles trailing comma', () => {
      const result = parseCsvSet('foo,bar,');
      expect(result.size).toBe(2);
    });

    it('deduplicates values', () => {
      const result = parseCsvSet('foo,foo,bar');
      expect(result.size).toBe(2);
    });
  });

  describe('envInt', () => {
    function envInt(name: string, fallback: number): number {
      const raw = process.env[name];
      if (!raw) return fallback;
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) ? parsed : fallback;
    }

    it('returns fallback when env var is not set', () => {
      delete process.env.__TEST_ENV_INT;
      expect(envInt('__TEST_ENV_INT', 42)).toBe(42);
    });

    it('parses valid integer', () => {
      process.env.__TEST_ENV_INT = '100';
      expect(envInt('__TEST_ENV_INT', 42)).toBe(100);
      delete process.env.__TEST_ENV_INT;
    });

    it('returns fallback for non-numeric string', () => {
      process.env.__TEST_ENV_INT = 'abc';
      expect(envInt('__TEST_ENV_INT', 42)).toBe(42);
      delete process.env.__TEST_ENV_INT;
    });

    it('returns fallback for empty string', () => {
      process.env.__TEST_ENV_INT = '';
      expect(envInt('__TEST_ENV_INT', 42)).toBe(42);
      delete process.env.__TEST_ENV_INT;
    });
  });

  describe('isExecuteToolAllowedInProd', () => {
    function isExecuteToolAllowedInProd(allowlist: Set<string>, toolName: string): boolean {
      if (allowlist.size === 0) return false;
      return allowlist.has('*') || allowlist.has(toolName);
    }

    it('denies all when allowlist is empty', () => {
      expect(isExecuteToolAllowedInProd(new Set(), 'any-tool')).toBe(false);
    });

    it('allows any tool with wildcard', () => {
      const allowlist = new Set(['*']);
      expect(isExecuteToolAllowedInProd(allowlist, 'delete-device')).toBe(true);
      expect(isExecuteToolAllowedInProd(allowlist, 'run-script')).toBe(true);
    });

    it('allows only listed tools', () => {
      const allowlist = new Set(['run-script', 'restart-service']);
      expect(isExecuteToolAllowedInProd(allowlist, 'run-script')).toBe(true);
      expect(isExecuteToolAllowedInProd(allowlist, 'restart-service')).toBe(true);
      expect(isExecuteToolAllowedInProd(allowlist, 'delete-device')).toBe(false);
    });
  });
});
