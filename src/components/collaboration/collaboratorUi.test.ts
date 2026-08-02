import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CollaboratorSettings } from './CollaboratorSettings';
import type { NotebookCollaborator } from '@/lib/collaboration/types';
import {
  canManageNotebookMembers,
  canManageNotebookRoles,
  collaborationRoleLabel,
  collaboratorName,
  collaboratorSecondaryIdentity,
  shortIdentifier,
} from './collaboratorUi';

const collaborator = (overrides: Partial<NotebookCollaborator>): NotebookCollaborator => ({
  inboxId: 'inbox-alice-123456789',
  address: '0x1111111111111111111111111111111111111111',
  accountIdentifiers: [],
  installationIds: ['installation-1'],
  consentState: 1 as NotebookCollaborator['consentState'],
  permissionLevel: 0 as NotebookCollaborator['permissionLevel'],
  role: 'member',
  isCurrentUser: false,
  ...overrides,
});

describe('collaborator settings model', () => {
  it('maps native roles to human labels and capabilities', () => {
    expect(collaborationRoleLabel('super-admin')).toBe('Super admin');
    expect(canManageNotebookMembers('member')).toBe(false);
    expect(canManageNotebookMembers('admin')).toBe(true);
    expect(canManageNotebookRoles('admin')).toBe(false);
    expect(canManageNotebookRoles('super-admin')).toBe(true);
  });

  it('prefers ENS while preserving canonical address and inbox identity', () => {
    const alice = collaborator({ ensName: 'alice.eth' });
    expect(collaboratorName(alice)).toBe('alice.eth');
    expect(collaboratorSecondaryIdentity(alice)).toBe(shortIdentifier(alice.address!));
    expect(collaboratorName(collaborator({ address: null }))).toBe(shortIdentifier('inbox-alice-123456789'));
  });
});

describe('CollaboratorSettings', () => {
  const callbacks = {
    onAdd: vi.fn(async () => undefined),
    onChangeRole: vi.fn(async () => undefined),
    onRemove: vi.fn(async () => undefined),
    onRefresh: vi.fn(async () => undefined),
  };

  it('renders native roles and management controls for a super admin', () => {
    const html = renderToStaticMarkup(createElement(CollaboratorSettings, {
      collaborators: [
        collaborator({
          inboxId: 'inbox-self',
          address: '0x2222222222222222222222222222222222222222',
          role: 'super-admin',
          permissionLevel: 2 as NotebookCollaborator['permissionLevel'],
          isCurrentUser: true,
        }),
        collaborator({ ensName: 'alice.eth' }),
      ],
      ...callbacks,
    }));

    expect(html).toContain('Add by ENS name or Ethereum address');
    expect(html).toContain('aria-label="Role for alice.eth"');
    expect(html).toContain('aria-label="Remove alice.eth"');
    expect(html).toContain('Super admin');
    expect(html).toContain('You');
  });

  it('does not expose mutation controls to an ordinary member', () => {
    const html = renderToStaticMarkup(createElement(CollaboratorSettings, {
      collaborators: [
        collaborator({ inboxId: 'inbox-self', isCurrentUser: true }),
        collaborator({ ensName: 'alice.eth' }),
      ],
      ...callbacks,
    }));

    expect(html).toContain('An XMTP admin must add or remove collaborators.');
    expect(html).not.toContain('aria-label="Remove alice.eth"');
    expect(html).not.toContain('aria-label="Role for alice.eth"');
  });
});
