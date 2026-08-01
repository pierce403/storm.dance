import { describe, expect, it } from 'vitest';
import {
  LEGACY_SYNTHETIC_CONVERSATION_PREFIX,
  assertNotebookBindingEnvironment,
  hasMatchingNotebookBinding,
  normalizeConversationId,
  resolveNotebookBindingForInvitation,
  resolveSoleNotebookBinding,
} from './bindings';

describe('collaboration bindings', () => {
  it('rejects legacy synthetic notebook topics', () => {
    expect(normalizeConversationId(`${LEGACY_SYNTHETIC_CONVERSATION_PREFIX}notebook-1`)).toBeNull();
  });

  it('preserves a real XMTP conversation ID', () => {
    expect(normalizeConversationId('  real-mls-group-id  ')).toBe('real-mls-group-id');
  });

  it('resolves one explicit binding and interrupted state to their recorded environment', () => {
    expect(resolveSoleNotebookBinding({
      xmtpEnv: 'production',
      xmtpTopic: 'group-production',
      xmtpBindings: { production: 'group-production' },
    })).toEqual({ env: 'production', conversationId: 'group-production' });

    expect(resolveSoleNotebookBinding({}, {
      production: { conversationId: null },
    })).toEqual({ env: 'production', conversationId: null });
  });

  it('rejects cross-environment state and conflicting groups in one environment', () => {
    expect(() => resolveSoleNotebookBinding({
      xmtpBindings: { dev: 'dev-group', production: 'production-group' },
    })).toThrow('both XMTP environments');

    expect(() => resolveSoleNotebookBinding({
      xmtpEnv: 'dev',
      xmtpTopic: 'first-dev-group',
      xmtpBindings: { dev: 'second-dev-group' },
    })).toThrow('multiple XMTP groups in development');
  });

  it('requires an environment for a real legacy group unless another record disambiguates it', () => {
    expect(() => resolveSoleNotebookBinding({ xmtpTopic: 'legacy-real-group' }))
      .toThrow('without a recorded environment');
    expect(resolveSoleNotebookBinding({ xmtpTopic: 'legacy-real-group' }, {
      dev: { conversationId: 'legacy-real-group' },
    })).toEqual({ env: 'dev', conversationId: 'legacy-real-group' });
  });

  it('rejects starting in another environment or joining another group', () => {
    const binding = { env: 'production', conversationId: 'group-1' } as const;
    expect(() => assertNotebookBindingEnvironment(binding, 'dev'))
      .toThrow('already connected on XMTP production');
    expect(() => assertNotebookBindingEnvironment(binding, 'production', 'group-2'))
      .toThrow('different XMTP group in production');
    expect(() => assertNotebookBindingEnvironment(binding, 'production', 'group-1'))
      .not.toThrow();
  });

  it('uses an exact observed invitation to recover a legacy topic with no environment', () => {
    expect(resolveNotebookBindingForInvitation(
      { xmtpTopic: 'group-1' },
      {},
      'production',
      'group-1',
    )).toEqual({ env: 'production', conversationId: 'group-1' });
    expect(() => resolveNotebookBindingForInvitation(
      { xmtpTopic: 'other-group' },
      {},
      'production',
      'group-1',
    )).toThrow('without a recorded environment');
    expect(() => resolveNotebookBindingForInvitation(
      { xmtpTopic: 'group-1', xmtpBindings: { dev: 'group-1' } },
      {},
      'production',
      'group-1',
    )).toThrow('both XMTP environments');
  });

  it('recognizes exact local bindings for recoverable allowed invitations', () => {
    expect(hasMatchingNotebookBinding(
      { xmtpBindings: { dev: 'group-1' } },
      {},
      'dev',
      'group-1',
    )).toBe(true);
    expect(hasMatchingNotebookBinding(
      {},
      { dev: { conversationId: 'group-1' } },
      'dev',
      'group-1',
    )).toBe(true);
    expect(hasMatchingNotebookBinding(
      { xmtpTopic: 'group-1' },
      {},
      'dev',
      'group-1',
    )).toBe(false);
    expect(hasMatchingNotebookBinding({}, {}, 'dev', 'group-1')).toBe(false);
  });
});
