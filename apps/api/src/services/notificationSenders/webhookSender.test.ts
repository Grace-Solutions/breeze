import { describe, expect, it, vi } from 'vitest';
import {
  sendWebhookNotification,
  validateWebhookConfig,
  validateWebhookUrlSafety,
  redactUrlForLogs
} from './webhookSender';

describe('webhook sender safety', () => {
  it('rejects non-https and private URLs during config validation', () => {
    const result = validateWebhookConfig({
      url: 'http://127.0.0.1/webhook',
      method: 'POST'
    });

    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('HTTPS');
  });

  it('returns safety errors for loopback targets', () => {
    const errors = validateWebhookUrlSafety('https://127.0.0.1/webhook');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('fails closed before fetch when webhook URL is unsafe', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await sendWebhookNotification(
      {
        url: 'http://169.254.169.254/latest/meta-data',
        method: 'POST'
      },
      {
        alertId: 'alert-1',
        alertName: 'Test Alert',
        severity: 'high',
        summary: 'summary',
        orgId: 'org-1',
        triggeredAt: new Date().toISOString()
      }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unsafe webhook URL');
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });
});

describe('redactUrlForLogs', () => {
  it('strips query params and credentials', () => {
    expect(redactUrlForLogs('https://user:pass@example.com/hook?secret=abc'))
      .toBe('https://example.com/hook');
  });

  it('preserves path without sensitive parts', () => {
    expect(redactUrlForLogs('https://example.com/webhook/v2'))
      .toBe('https://example.com/webhook/v2');
  });

  it('returns [invalid-url] for garbage input', () => {
    expect(redactUrlForLogs('not-a-url')).toBe('[invalid-url]');
  });

  it('preserves port numbers', () => {
    expect(redactUrlForLogs('https://example.com:8443/hook'))
      .toBe('https://example.com:8443/hook');
  });

  it('strips hash fragments', () => {
    expect(redactUrlForLogs('https://example.com/hook#section'))
      .toBe('https://example.com/hook');
  });
});
