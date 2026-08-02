import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConsentState, Group, type Identifier } from '@xmtp/browser-sdk';
import { resolveEnsOrAddress, type EnsResolver } from '@/lib/collaboration/contacts';
import {
  assertNotebookBindingEnvironment,
  hasMatchingNotebookBinding,
  normalizeConversationId,
  resolveNotebookBindingForInvitation,
  resolveSoleNotebookBinding,
  type PersistedBindingStates,
  type XmtpEnvironment,
} from '@/lib/collaboration/bindings';
import {
  NotebookCollaborationSession,
  parseGroupDescription,
  type NoteShape,
  type XmtpClientLike,
  type XmtpGroupLike,
} from '@/lib/collaboration/notebookCollaboration';
import {
  NotebookCollaboratorManager,
  type NotebookCollaboratorState,
} from '@/lib/collaboration/collaborators';
import {
  NotebookCrdt,
  mergeCrdtUpdates,
  type NotebookCrdtProjection,
} from '@/lib/collaboration/crdt';
import type {
  CollaborationContact,
  CollaborationRole,
  InvitePayload,
  NotebookCollaborator,
} from '@/lib/collaboration/types';
import { dbService, type Notebook } from '@/lib/db';
import type { BrowserClient } from '@/lib/xmtp-browser-sdk';
import {
  applyNativeNotebookState,
  type NativeCrdtUpdate,
} from '@/lib/nativeBridge';

export type CollaborationStatus = 'idle' | 'starting' | 'active' | 'error';

interface UseNotebookCollaborationProps {
  client: BrowserClient | null;
  userAddress: string | null;
  xmtpEnv: 'dev' | 'production';
  onRemoteProjection: (projection: NotebookCrdtProjection) => Promise<void> | void;
  onNotebookUpdated?: (notebook: Notebook) => Promise<void> | void;
  ensResolver?: EnsResolver;
  debugLoggingEnabled: boolean;
}

const copyArrayBuffer = (bytes: Uint8Array) => Uint8Array.from(bytes).buffer;

const equalBytes = (left: Uint8Array, right: Uint8Array) => {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

const loadEnvironmentStates = async (notebookId: string) => {
  const [dev, production] = await Promise.all([
    dbService.getCollaborationState(notebookId, 'dev'),
    dbService.getCollaborationState(notebookId, 'production'),
  ]);
  return { dev, production };
};

const asBindingStates = (
  states: Awaited<ReturnType<typeof loadEnvironmentStates>>,
): PersistedBindingStates => ({
  ...(states.dev ? { dev: { conversationId: states.dev.conversationId } } : {}),
  ...(states.production
    ? { production: { conversationId: states.production.conversationId } }
    : {}),
});

const stateForEnvironment = (
  states: Awaited<ReturnType<typeof loadEnvironmentStates>>,
  env: XmtpEnvironment,
) => states[env];

export function useNotebookCollaboration({
  client: rawClient,
  userAddress,
  xmtpEnv,
  onRemoteProjection,
  onNotebookUpdated,
  ensResolver,
  debugLoggingEnabled,
}: UseNotebookCollaborationProps) {
  const [contacts, setContacts] = useState<CollaborationContact[]>([]);
  const [contactsNotebookId, setContactsNotebookId] = useState<string | null>(null);
  const [status, setStatus] = useState<CollaborationStatus>('idle');
  const [sessionNotebookId, setSessionNotebookId] = useState<string | null>(null);
  const [sessionTopic, setSessionTopic] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [collaborators, setCollaborators] = useState<NotebookCollaborator[]>([]);
  const [currentUserRole, setCurrentUserRole] = useState<CollaborationRole | null>(null);
  const [collaboratorsPending, setCollaboratorsPending] = useState(false);
  const [collaboratorsError, setCollaboratorsError] = useState<string | null>(null);
  const [inviteQueue, setInviteQueue] = useState<InvitePayload[]>([]);
  const sessionRef = useRef<NotebookCollaborationSession | null>(null);
  const collaboratorManagerRef = useRef<NotebookCollaboratorManager | null>(null);
  const sessionGenerationRef = useRef(0);
  const inviteGenerationRef = useRef(0);
  const inviteActionRef = useRef<string | null>(null);
  const statePersistenceQueueRef = useRef<Promise<void>>(Promise.resolve());
  const clientRef = useRef<XmtpClientLike | null>(null);
  const inviteDetails = inviteQueue[0] ?? null;
  const inviteModalOpen = inviteDetails !== null;

  const applyCollaboratorState = useCallback((
    manager: NotebookCollaboratorManager,
    state: NotebookCollaboratorState,
  ) => {
    if (collaboratorManagerRef.current !== manager) return false;
    setCollaborators(state.collaborators);
    setCurrentUserRole(state.currentUserRole);
    return true;
  }, []);

  const client = useMemo<XmtpClientLike | null>(() => {
    if (!rawClient || !userAddress) return null;
    return {
      inboxId: rawClient.inboxId,
      address: userAddress,
      canMessage: rawClient.canMessage.bind(rawClient),
      conversations: {
        newGroupWithIdentifiers: async (identifiers, options) =>
          await rawClient.conversations.newGroupWithIdentifiers(identifiers, options) as unknown as XmtpGroupLike,
        getConversationById: async (id) => {
          await rawClient.conversations.sync();
          const conversation = await rawClient.conversations.getConversationById(id);
          return conversation instanceof Group
            ? conversation as unknown as XmtpGroupLike
            : undefined;
        },
      },
    };
  }, [rawClient, userAddress]);
  clientRef.current = client;

  const inspectIncomingGroup = useCallback(async (group: Group, generation: number) => {
    const isCurrent = () => inviteGenerationRef.current === generation;
    try {
      await group.sync?.();
      if (!isCurrent()) return;
      const notebookId = parseGroupDescription(group.description);
      if (!notebookId) return;
      if (group.addedByInboxId === rawClient?.inboxId) return;
      const consentState = await group.consentState();
      if (
        !isCurrent()
        || (consentState !== ConsentState.Unknown && consentState !== ConsentState.Allowed)
      ) return;

      const existing = await dbService.getNotebook(notebookId);
      if (!isCurrent()) return;
      // Allowed groups are inspected too so a consent change followed by a
      // failed local write does not make the invitation disappear forever.
      // Only notebook metadata counts as a completed local binding here;
      // orphaned persisted state should still be recoverable through the UI.
      if (hasMatchingNotebookBinding(existing, {}, xmtpEnv, group.id)) return;

      const notebookName = typeof group.name === 'string'
        ? group.name.replace(/^storm\.dance\s*·\s*/, '') || 'Shared notebook'
        : 'Shared notebook';
      const invite: InvitePayload = {
        notebookId,
        notebookName,
        conversationId: group.id,
        env: xmtpEnv,
        inviterName: 'An XMTP contact',
        inviterInboxId: group.addedByInboxId,
      };
      if (!isCurrent()) return;
      setInviteQueue((previous) => previous.some((candidate) => candidate.conversationId === group.id)
        ? previous
        : [...previous, invite]);
    } catch (error) {
      if (debugLoggingEnabled) console.warn('Could not inspect XMTP group invitation', error);
    }
  }, [debugLoggingEnabled, rawClient?.inboxId, xmtpEnv]);

  useEffect(() => {
    if (!rawClient) return;
    let active = true;
    let groupStream: { end: () => Promise<unknown> } | null = null;
    const generation = ++inviteGenerationRef.current;

    const inspectCurrentGroups = async () => {
      await rawClient.conversations.sync();
      if (!active || inviteGenerationRef.current !== generation) return;
      const groups = await rawClient.conversations.listGroups();
      if (!active || inviteGenerationRef.current !== generation) return;
      for (const group of groups) {
        if (!active) return;
        await inspectIncomingGroup(group, generation);
      }
    };

    void (async () => {
      try {
        const nextStream = await rawClient.conversations.streamGroups({
          onValue: (group: Group) => {
            if (active) void inspectIncomingGroup(group, generation);
          },
          onError: (error: Error) => console.warn('XMTP group invitation stream error', error),
          onFail: () => console.warn('XMTP group invitation stream failed'),
          onRestart: () => {
            if (active) void inspectCurrentGroups();
          },
        });
        if (!active) {
          await nextStream.end();
          return;
        }
        groupStream = nextStream;
        await inspectCurrentGroups();
      } catch (error) {
        console.warn('Failed to start XMTP group invitation stream', error);
      }
    })();

    return () => {
      active = false;
      if (inviteGenerationRef.current === generation) inviteGenerationRef.current += 1;
      if (groupStream) {
        void groupStream.end().catch((error) => {
          if (debugLoggingEnabled) console.warn('Could not close XMTP group invitation stream', error);
        });
      }
    };
  }, [debugLoggingEnabled, rawClient, inspectIncomingGroup]);

  useEffect(() => {
    setInviteQueue([]);
  }, [rawClient, xmtpEnv]);

  const addContact = useCallback(async (value: string, notebookId: string) => {
    setSessionError(null);
    try {
      if (!client) throw new Error('Connect to XMTP first');
      if (!notebookId) throw new Error('Select a notebook before adding collaborators');
      const resolved = await resolveEnsOrAddress(value, ensResolver);
      if (
        contactsNotebookId === notebookId
        && contacts.some((contact) => contact.address.toLowerCase() === resolved.address.toLowerCase())
      ) return;

      const identifier: Identifier = { identifierKind: 'Ethereum', identifier: resolved.address };
      const reachable = await client.canMessage([identifier]);
      const canReach = reachable.get(resolved.address) ?? reachable.get(resolved.address.toLowerCase());
      if (!canReach) throw new Error('Contact is not reachable on the selected XMTP network');
      setContacts((previous) => contactsNotebookId === notebookId
        ? [...previous, resolved]
        : [resolved]);
      setContactsNotebookId(notebookId);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : 'Failed to add collaborator');
      throw error;
    }
  }, [client, contacts, contactsNotebookId, ensResolver]);

  const removeContact = useCallback((address: string, notebookId: string) => {
    if (contactsNotebookId !== notebookId) return;
    setContacts((previous) => previous.filter((contact) => contact.address.toLowerCase() !== address.toLowerCase()));
  }, [contactsNotebookId]);

  const persistCollaborationState = useCallback((
    notebookId: string,
    state: Uint8Array,
    conversationId: string | null,
    env: 'dev' | 'production',
  ) => {
    const queued = statePersistenceQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const current = await dbService.getCollaborationState(notebookId, env);
        const merged = current?.state.byteLength
          ? mergeCrdtUpdates([new Uint8Array(current.state), state])
          : state;
        const nextConversationId = normalizeConversationId(conversationId)
          ?? normalizeConversationId(current?.conversationId);
        await dbService.putCollaborationState(
          notebookId,
          copyArrayBuffer(merged),
          nextConversationId,
          env,
        );
        if (nextConversationId) {
          try {
            await applyNativeNotebookState(
              notebookId,
              nextConversationId,
              env,
              merged,
            );
          } catch (error) {
            console.warn('Could not materialize browser CRDT state into a native vault', error);
            throw error;
          }
        }
      });
    statePersistenceQueueRef.current = queued;
    return queued;
  }, []);

  const applyNativeUpdate = useCallback(async (
    nativeUpdate: NativeCrdtUpdate,
    update: Uint8Array,
  ) => {
    const conversationId = normalizeConversationId(nativeUpdate.conversationId);
    if (!conversationId) throw new Error('Native vault update has no XMTP conversation binding');

    const activeSession = sessionRef.current;
    if (
      activeSession?.notebookId === nativeUpdate.notebookId
      && activeSession.topic === conversationId
      && nativeUpdate.env === xmtpEnv
    ) {
      return activeSession.applyNativeUpdate(update);
    }

    const queued = statePersistenceQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const [notebook, states] = await Promise.all([
          dbService.getNotebook(nativeUpdate.notebookId),
          loadEnvironmentStates(nativeUpdate.notebookId),
        ]);
        if (!notebook) throw new Error(`Native vault notebook ${nativeUpdate.notebookId} is not available locally`);
        const persisted = stateForEnvironment(states, nativeUpdate.env);
        const notebookBinding = normalizeConversationId(notebook.xmtpBindings?.[nativeUpdate.env])
          ?? (notebook.xmtpEnv === nativeUpdate.env
            ? normalizeConversationId(notebook.xmtpTopic)
            : null);
        const storedBinding = normalizeConversationId(persisted?.conversationId) ?? notebookBinding;
        if (storedBinding !== conversationId) {
          throw new Error('Native vault XMTP conversation does not match the browser notebook binding');
        }

        const crdt = new NotebookCrdt(nativeUpdate.notebookId);
        try {
          if (persisted?.state.byteLength) {
            crdt.applyUpdate(new Uint8Array(persisted.state));
          }
          const before = crdt.encodeStateVector();
          crdt.applyLocalUpdate(update);
          if (equalBytes(before, crdt.encodeStateVector())) return false;
          const mergedState = crdt.encodeUpdate();
          await dbService.putCollaborationState(
            nativeUpdate.notebookId,
            copyArrayBuffer(mergedState),
            conversationId,
            nativeUpdate.env,
          );
          await onRemoteProjection(crdt.snapshot());
          // An inactive/offline notebook has no collaboration session whose
          // persistence callback can fan this state out. Applying it here keeps
          // every matching watched vault convergent; Rust's merged-state echo is
          // idempotent because unchanged state vectors return above.
          await applyNativeNotebookState(
            nativeUpdate.notebookId,
            conversationId,
            nativeUpdate.env,
            mergedState,
          );
          return true;
        } finally {
          crdt.destroy();
        }
      });
    statePersistenceQueueRef.current = queued.then(() => undefined);
    return queued;
  }, [onRemoteProjection, xmtpEnv]);

  const persistInactiveLocalNote = useCallback((note: NoteShape) => {
    const queued = statePersistenceQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const [notebook, states] = await Promise.all([
          dbService.getNotebook(note.notebookId),
          loadEnvironmentStates(note.notebookId),
        ]);
        if (!notebook) return;
        const binding = resolveSoleNotebookBinding(notebook, asBindingStates(states));
        if (!binding) return;
        const persisted = stateForEnvironment(states, binding.env);

        const crdt = new NotebookCrdt(note.notebookId);
        try {
          if (persisted?.state.byteLength) {
            crdt.applyUpdate(new Uint8Array(persisted.state));
          } else {
            crdt.seed(notebook, await dbService.getAllNotes(note.notebookId));
          }
          // The app broadcasts optimistically before its IndexedDB write, so
          // the passed value—not the materialized row—is the newest local edit.
          crdt.upsertNote(note);
          const mergedState = crdt.encodeUpdate();
          await dbService.putCollaborationState(
            note.notebookId,
            copyArrayBuffer(mergedState),
            binding.conversationId,
            binding.env,
          );
          if (binding.conversationId) {
            await applyNativeNotebookState(
              note.notebookId,
              binding.conversationId,
              binding.env,
              mergedState,
            );
          }
        } finally {
          crdt.destroy();
        }
      });
    statePersistenceQueueRef.current = queued;
    return queued;
  }, []);

  const persistInactiveNotebookRename = useCallback((
    notebookId: string,
    name: string,
    updatedAt: number,
  ) => {
    const queued = statePersistenceQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const [notebook, states] = await Promise.all([
          dbService.getNotebook(notebookId),
          loadEnvironmentStates(notebookId),
        ]);
        if (!notebook) return;
        const binding = resolveSoleNotebookBinding(notebook, asBindingStates(states));
        if (!binding) return;
        const persisted = stateForEnvironment(states, binding.env);

        const crdt = new NotebookCrdt(notebookId);
        try {
          if (persisted?.state.byteLength) crdt.applyUpdate(new Uint8Array(persisted.state));
          else crdt.seed(notebook, await dbService.getAllNotes(notebookId));
          crdt.updateNotebook({ name, updatedAt });
          const mergedState = crdt.encodeUpdate();
          await dbService.putCollaborationState(
            notebookId,
            copyArrayBuffer(mergedState),
            binding.conversationId,
            binding.env,
          );
          if (binding.conversationId) {
            await applyNativeNotebookState(
              notebookId,
              binding.conversationId,
              binding.env,
              mergedState,
            );
          }
        } finally {
          crdt.destroy();
        }
      });
    statePersistenceQueueRef.current = queued;
    return queued;
  }, []);

  const stopCollaboration = useCallback(async () => {
    const generation = ++sessionGenerationRef.current;
    const activeSession = sessionRef.current;
    sessionRef.current = null;
    collaboratorManagerRef.current = null;
    setCollaboratorsPending(false);
    setCollaboratorsError(null);
    setCollaborators([]);
    setCurrentUserRole(null);
    try {
      if (activeSession) await activeSession.stop();
    } finally {
      if (sessionGenerationRef.current === generation) {
        setStatus('idle');
        setSessionError(null);
        setSessionNotebookId(null);
        setSessionTopic(null);
      }
    }
  }, []);

  const loadActiveCollaboratorManager = useCallback(async () => {
    const existing = collaboratorManagerRef.current;
    if (existing) return existing;
    const activeSession = sessionRef.current;
    const conversationId = activeSession?.topic;
    if (!rawClient || !activeSession || !conversationId) {
      throw new Error('Start or resume this notebook collaboration first');
    }

    await rawClient.conversations.sync();
    const collaboratorGroup = await rawClient.conversations.getConversationById(conversationId);
    if (!(collaboratorGroup instanceof Group)) {
      throw new Error('XMTP notebook collaborator group is not available');
    }
    if (sessionRef.current !== activeSession || activeSession.topic !== conversationId) {
      throw new Error('XMTP collaboration session changed while collaborators were loading');
    }

    const manager = new NotebookCollaboratorManager({
      client: rawClient,
      group: collaboratorGroup,
      ensResolver,
    });
    collaboratorManagerRef.current = manager;
    return manager;
  }, [ensResolver, rawClient]);

  useEffect(() => () => {
    void stopCollaboration().catch((error) => {
      console.warn('Could not stop XMTP collaboration cleanly', error);
    });
  }, [rawClient, stopCollaboration]);

  const startSession = useCallback(async (
    notebookId: string,
    notebookName: string,
    options: { contacts?: CollaborationContact[]; conversationId?: string | null } = {},
  ) => {
    if (!client || !rawClient) throw new Error('Connect to XMTP first');
    if (!notebookId) throw new Error('Select a notebook before collaborating');
    const generation = ++sessionGenerationRef.current;
    const isCurrent = () => sessionGenerationRef.current === generation && clientRef.current === client;
    const previousSession = sessionRef.current;
    sessionRef.current = null;
    collaboratorManagerRef.current = null;
    setCollaboratorsPending(false);
    setCollaboratorsError(null);
    setCollaborators([]);
    setCurrentUserRole(null);
    try {
      if (previousSession) await previousSession.stop();
    } catch (error) {
      if (!isCurrent()) return null;
      throw error;
    }
    if (!isCurrent()) return null;
    await statePersistenceQueueRef.current.catch(() => undefined);
    if (!isCurrent()) return null;

    const loadNotebook = () => Promise.all([
      dbService.getNotebook(notebookId),
      dbService.getAllNotes(notebookId),
      loadEnvironmentStates(notebookId),
    ] as const);
    let loaded: Awaited<ReturnType<typeof loadNotebook>>;
    try {
      loaded = await loadNotebook();
    } catch (error) {
      if (!isCurrent()) return null;
      throw error;
    }
    const [notebook, notes, states] = loaded;
    if (!isCurrent()) return null;
    if (!notebook) throw new Error(`Notebook ${notebookId} was not found locally`);
    const binding = resolveSoleNotebookBinding(notebook, asBindingStates(states));
    assertNotebookBindingEnvironment(binding, xmtpEnv, options.conversationId);
    const persisted = stateForEnvironment(states, xmtpEnv);
    const conversationId = normalizeConversationId(options.conversationId)
      ?? binding?.conversationId
      ?? null;
    const creatingGroup = conversationId === null;
    const collabSession = new NotebookCollaborationSession({
      notebook: { id: notebook.id, name: notebookName || notebook.name, createdAt: notebook.createdAt, updatedAt: notebook.updatedAt },
      notes,
      client,
      initialState: persisted ? new Uint8Array(persisted.state) : undefined,
      conversationId,
      debugLoggingEnabled,
      onRemoteProjection,
      onStateChange: async (state, nextConversationId) => {
        await persistCollaborationState(notebookId, state, nextConversationId, xmtpEnv);
      },
    });

    if (!isCurrent()) {
      await collabSession.stop().catch(() => undefined);
      return null;
    }
    sessionRef.current = collabSession;
    let keepSession = false;
    try {
      if (persisted?.state.byteLength) {
        // Persisted Yjs is authoritative. Materialize it before any live
        // replay instead of seeding possibly stale IndexedDB rows over it.
        await onRemoteProjection(collabSession.projection);
      }
      if (!isCurrent() || sessionRef.current !== collabSession) return null;

      const nextConversationId = await collabSession.start(options.contacts ?? []);
      if (!isCurrent() || sessionRef.current !== collabSession) return null;
      if (!nextConversationId) throw new Error('XMTP group did not return a conversation ID');

      const updatedNotebook = await dbService.updateNotebook(notebookId, {
        xmtpTopic: nextConversationId,
        xmtpEnv,
        xmtpBindings: { ...notebook.xmtpBindings, [xmtpEnv]: nextConversationId },
      });
      if (!updatedNotebook) throw new Error(`Notebook ${notebookId} disappeared while collaboration was starting`);
      if (!isCurrent() || sessionRef.current !== collabSession) return null;

      await onNotebookUpdated?.(updatedNotebook);
      if (!isCurrent() || sessionRef.current !== collabSession) return null;
      if (creatingGroup && contactsNotebookId === notebookId) {
        setContacts([]);
        setContactsNotebookId(null);
      }
      setSessionNotebookId(notebookId);
      setSessionTopic(nextConversationId);
      setStatus('active');
      keepSession = true;

      // Membership projection is settings data, not a prerequisite for CRDT
      // transport. Persist and activate the notebook binding first so a
      // transient member-list failure cannot orphan a newly-created MLS group.
      setCollaboratorsPending(true);
      try {
        await rawClient.conversations.sync();
        if (!isCurrent() || sessionRef.current !== collabSession) return null;
        const collaboratorGroup = await rawClient.conversations.getConversationById(nextConversationId);
        if (!(collaboratorGroup instanceof Group)) {
          throw new Error('XMTP notebook collaborator group is not available');
        }
        const collaboratorManager = new NotebookCollaboratorManager({
          client: rawClient,
          group: collaboratorGroup,
          ensResolver,
        });
        collaboratorManagerRef.current = collaboratorManager;
        const collaboratorState = await collaboratorManager.refresh();
        if (
          isCurrent()
          && sessionRef.current === collabSession
          && collaboratorManagerRef.current === collaboratorManager
        ) {
          applyCollaboratorState(collaboratorManager, collaboratorState);
        }
      } catch (error) {
        if (isCurrent() && sessionRef.current === collabSession) {
          setCollaboratorsError(error instanceof Error
            ? error.message
            : 'Failed to load notebook collaborators');
        }
      } finally {
        if (isCurrent() && sessionRef.current === collabSession) {
          setCollaboratorsPending(false);
        }
      }
      return nextConversationId;
    } finally {
      if (!keepSession) {
        collaboratorManagerRef.current = null;
        setCollaborators([]);
        setCurrentUserRole(null);
        await collabSession.stop().catch((error) => {
          if (debugLoggingEnabled) console.warn('Could not clean up failed XMTP collaboration session', error);
        });
        if (sessionRef.current === collabSession) sessionRef.current = null;
      }
    }
  }, [
    applyCollaboratorState,
    client,
    debugLoggingEnabled,
    ensResolver,
    contactsNotebookId,
    onNotebookUpdated,
    onRemoteProjection,
    persistCollaborationState,
    rawClient,
    xmtpEnv,
  ]);

  const startCollaboration = useCallback(async (notebookId: string, notebookName: string) => {
    setStatus('starting');
    setSessionError(null);
    try {
      await startSession(notebookId, notebookName, {
        contacts: contactsNotebookId === notebookId ? contacts : [],
      });
    } catch (error) {
      sessionRef.current = null;
      setStatus('error');
      setSessionError(error instanceof Error ? error.message : 'Failed to start collaboration');
    }
  }, [contacts, contactsNotebookId, startSession]);

  const resumeCollaboration = useCallback(async (notebookId: string, notebookName: string) => {
    if (sessionRef.current && sessionNotebookId === notebookId) return;
    setStatus('starting');
    setSessionError(null);
    try {
      await startSession(notebookId, notebookName);
    } catch (error) {
      sessionRef.current = null;
      setStatus('error');
      setSessionError(error instanceof Error ? error.message : 'Failed to resume collaboration');
    }
  }, [sessionNotebookId, startSession]);

  const refreshCollaborators = useCallback(async () => {
    let manager = collaboratorManagerRef.current;
    setCollaboratorsPending(true);
    setCollaboratorsError(null);
    try {
      manager ??= await loadActiveCollaboratorManager();
      const state = await manager.refresh();
      applyCollaboratorState(manager, state);
    } catch (error) {
      if (!manager || collaboratorManagerRef.current === manager) {
        setCollaboratorsError(error instanceof Error
          ? error.message
          : 'Failed to refresh notebook collaborators');
      }
    } finally {
      if (!manager || collaboratorManagerRef.current === manager) setCollaboratorsPending(false);
    }
  }, [applyCollaboratorState, loadActiveCollaboratorManager]);

  const addNotebookCollaborator = useCallback(async (
    value: string,
    role: CollaborationRole = 'member',
  ) => {
    let manager: NotebookCollaboratorManager | null = null;
    setCollaboratorsPending(true);
    setCollaboratorsError(null);
    try {
      manager = await loadActiveCollaboratorManager();
      const added = await manager.add(value);
      let state = added.state;
      applyCollaboratorState(manager, state);
      if (role !== 'member') {
        state = await manager.setRole(added.collaborator.inboxId, role);
        applyCollaboratorState(manager, state);
      }
    } catch (error) {
      if (!manager || collaboratorManagerRef.current === manager) {
        setCollaboratorsError(error instanceof Error
          ? error.message
          : 'Failed to add notebook collaborator');
      }
      throw error;
    } finally {
      if (!manager || collaboratorManagerRef.current === manager) setCollaboratorsPending(false);
    }
  }, [applyCollaboratorState, loadActiveCollaboratorManager]);

  const changeNotebookCollaboratorRole = useCallback(async (
    inboxId: string,
    role: CollaborationRole,
  ) => {
    let manager: NotebookCollaboratorManager | null = null;
    setCollaboratorsPending(true);
    setCollaboratorsError(null);
    try {
      manager = await loadActiveCollaboratorManager();
      const state = await manager.setRole(inboxId, role);
      applyCollaboratorState(manager, state);
    } catch (error) {
      if (!manager || collaboratorManagerRef.current === manager) {
        setCollaboratorsError(error instanceof Error
          ? error.message
          : 'Failed to change collaborator role');
      }
      throw error;
    } finally {
      if (!manager || collaboratorManagerRef.current === manager) setCollaboratorsPending(false);
    }
  }, [applyCollaboratorState, loadActiveCollaboratorManager]);

  const removeNotebookCollaborator = useCallback(async (inboxId: string) => {
    let manager: NotebookCollaboratorManager | null = null;
    setCollaboratorsPending(true);
    setCollaboratorsError(null);
    try {
      manager = await loadActiveCollaboratorManager();
      const state = await manager.remove(inboxId);
      applyCollaboratorState(manager, state);
    } catch (error) {
      if (!manager || collaboratorManagerRef.current === manager) {
        setCollaboratorsError(error instanceof Error
          ? error.message
          : 'Failed to remove notebook collaborator');
      }
      throw error;
    } finally {
      if (!manager || collaboratorManagerRef.current === manager) setCollaboratorsPending(false);
    }
  }, [applyCollaboratorState, loadActiveCollaboratorManager]);

  const broadcastLocalUpdate = useCallback((note: NoteShape) => {
    const activeSession = sessionRef.current;
    if (activeSession?.notebookId === note.notebookId) {
      activeSession.upsertLocalNote(note);
      return;
    }
    void persistInactiveLocalNote(note).catch((error) => {
      console.warn('Could not persist an offline collaborative note update', error);
    });
  }, [persistInactiveLocalNote]);

  const broadcastLocalDelete = useCallback(async (note: NoteShape, deletedAt = Date.now()) => {
    const activeSession = sessionRef.current;
    if (activeSession?.notebookId === note.notebookId) {
      activeSession.deleteLocalNote(note.id, deletedAt);
      return;
    }

    // Serialize the read/modify/write as one state operation. In particular,
    // an offline edit queued immediately before deletion must become causal
    // state before the tombstone is created, rather than two competing Y.Docs.
    const queued = statePersistenceQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const [notebook, states] = await Promise.all([
          dbService.getNotebook(note.notebookId),
          loadEnvironmentStates(note.notebookId),
        ]);
        if (!notebook) return;
        const binding = resolveSoleNotebookBinding(notebook, asBindingStates(states));
        if (!binding) return;
        const persisted = stateForEnvironment(states, binding.env);

        const crdt = new NotebookCrdt(note.notebookId);
        try {
          if (persisted?.state.byteLength) {
            crdt.applyUpdate(new Uint8Array(persisted.state));
            if (!crdt.getNote(note.id)) crdt.upsertNote(note);
          } else {
            crdt.seed(notebook, await dbService.getAllNotes(note.notebookId));
          }
          crdt.deleteNote(note.id, deletedAt);
          const mergedState = crdt.encodeUpdate();
          await dbService.putCollaborationState(
            note.notebookId,
            copyArrayBuffer(mergedState),
            binding.conversationId,
            binding.env,
          );
          if (binding.conversationId) {
            await applyNativeNotebookState(
              note.notebookId,
              binding.conversationId,
              binding.env,
              mergedState,
            );
          }
        } finally {
          crdt.destroy();
        }
      });
    statePersistenceQueueRef.current = queued;
    await queued;
  }, []);

  const broadcastNotebookRename = useCallback((
    notebookId: string,
    name: string,
    updatedAt = Date.now(),
  ) => {
    const activeSession = sessionRef.current;
    if (activeSession?.notebookId === notebookId) {
      activeSession.updateNotebook(name, updatedAt);
      return;
    }
    void persistInactiveNotebookRename(notebookId, name, updatedAt).catch((error) => {
      console.warn('Could not persist an offline collaborative notebook rename', error);
    });
  }, [persistInactiveNotebookRename]);

  const acceptInvite = useCallback(async () => {
    const accepted = inviteDetails;
    if (!accepted || !rawClient) return;
    if (accepted.env !== xmtpEnv) {
      setSessionError('This invitation belongs to a different XMTP environment');
      return;
    }
    if (inviteActionRef.current === accepted.conversationId) return;
    inviteActionRef.current = accepted.conversationId;
    const generation = inviteGenerationRef.current;
    const isCurrent = () => inviteGenerationRef.current === generation && accepted.env === xmtpEnv;
    setStatus('starting');
    setSessionError(null);
    try {
      await rawClient.conversations.sync();
      if (!isCurrent()) return;
      const group = await rawClient.conversations.getConversationById(accepted.conversationId);
      if (!(group instanceof Group)) throw new Error('XMTP collaboration group is not available');
      const [existing, states] = await Promise.all([
        dbService.getNotebook(accepted.notebookId),
        loadEnvironmentStates(accepted.notebookId),
      ]);
      if (!isCurrent()) return;
      resolveNotebookBindingForInvitation(
        existing,
        asBindingStates(states),
        accepted.env,
        accepted.conversationId,
      );

      const timestamp = Date.now();
      const notebook = existing
        ? await dbService.updateNotebook(existing.id, {
          xmtpTopic: accepted.conversationId,
          xmtpEnv: accepted.env,
          xmtpBindings: { ...existing.xmtpBindings, [accepted.env]: accepted.conversationId },
        })
        : await dbService.createReplicaNotebook({
          id: accepted.notebookId,
          name: accepted.notebookName,
          createdAt: timestamp,
          updatedAt: timestamp,
          xmtpTopic: accepted.conversationId,
          xmtpEnv: accepted.env,
          xmtpBindings: { [accepted.env]: accepted.conversationId },
        });
      if (!notebook) throw new Error('Could not create the shared notebook locally');
      if (!isCurrent()) return;

      // Make the local binding durable before changing inbox-wide consent. If
      // a later network step fails, reload can auto-resume the bound notebook;
      // Allowed-but-unbound groups are also rediscovered by invitation scan.
      await group.updateConsentState(ConsentState.Allowed);
      if (!isCurrent()) return;
      await onNotebookUpdated?.(notebook);
      if (!isCurrent()) return;
      const joinedConversationId = await startSession(notebook.id, notebook.name, {
        conversationId: accepted.conversationId,
      });
      if (!joinedConversationId || !isCurrent()) return;
      setInviteQueue((previous) => previous.filter(
        (candidate) => candidate.conversationId !== accepted.conversationId,
      ));
    } catch (error) {
      if (isCurrent()) {
        setStatus('error');
        setSessionError(error instanceof Error ? error.message : 'Failed to join collaboration');
      }
    } finally {
      if (inviteActionRef.current === accepted.conversationId) inviteActionRef.current = null;
    }
  }, [inviteDetails, onNotebookUpdated, rawClient, startSession, xmtpEnv]);

  const rejectInvite = useCallback(async () => {
    const rejected = inviteDetails;
    if (rejected) {
      setInviteQueue((previous) => previous.filter(
        (candidate) => candidate.conversationId !== rejected.conversationId,
      ));
    }
    if (!rejected || !rawClient) return;
    if (rejected.env !== xmtpEnv) return;
    try {
      await rawClient.conversations.sync();
      const group = await rawClient.conversations.getConversationById(rejected.conversationId);
      if (group instanceof Group) await group.updateConsentState(ConsentState.Denied);
    } catch (error) {
      if (debugLoggingEnabled) console.warn('Could not reject XMTP group invitation', error);
    }
  }, [debugLoggingEnabled, inviteDetails, rawClient, xmtpEnv]);

  return {
    contacts,
    contactsNotebookId,
    collaborators,
    currentUserRole,
    collaboratorsPending,
    status,
    sessionNotebookId,
    sessionTopic,
    error: sessionError,
    collaboratorsError,
    canCollaborate: !!client,
    addContact,
    removeContact,
    refreshCollaborators,
    addNotebookCollaborator,
    changeNotebookCollaboratorRole,
    removeNotebookCollaborator,
    startCollaboration,
    resumeCollaboration,
    stopCollaboration,
    broadcastLocalUpdate,
    broadcastLocalDelete,
    broadcastNotebookRename,
    applyNativeUpdate,
    inviteModalOpen,
    inviteDetails,
    acceptInvite,
    rejectInvite,
  };
}
