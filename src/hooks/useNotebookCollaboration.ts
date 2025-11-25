import { useCallback, useMemo, useState, useEffect } from 'react';
import { resolveEnsOrAddress, type EnsResolver } from '@/lib/collaboration/contacts';
import { NotebookCollaborationSession, type NoteShape, type XmtpClientLike } from '@/lib/collaboration/notebookCollaboration';
import { CollaborationContact, CrdtUpdatePayload, InvitePayload, CollaborationMessage } from '@/lib/collaboration/types';
import type { DecodedMessage } from '@xmtp/browser-sdk';
import { dbService } from '@/lib/db';

export type CollaborationStatus = 'idle' | 'starting' | 'active' | 'error';

interface UseNotebookCollaborationProps {
  client: any | null; // Accept raw client and wrap it
  userAddress: string | null;
  onRemoteUpdate: (update: CrdtUpdatePayload) => Promise<void> | void;
  ensResolver?: EnsResolver;
  debugLoggingEnabled: boolean;
}

export function useNotebookCollaboration({ client: rawClient, userAddress, onRemoteUpdate, ensResolver, debugLoggingEnabled }: UseNotebookCollaborationProps) {
  const [contacts, setContacts] = useState<CollaborationContact[]>([]);
  const [status, setStatus] = useState<CollaborationStatus>('idle');
  const [sessionNotebookId, setSessionNotebookId] = useState<string | null>(null);
  const [sessionTopic, setSessionTopic] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [session, setSession] = useState<NotebookCollaborationSession | null>(null);

  // Invite State
  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [inviteDetails, setInviteDetails] = useState<InvitePayload | null>(null);

  const client = useMemo<XmtpClientLike | null>(() => {
    if (!rawClient || !userAddress) return null;
    return {
      inboxId: rawClient.inboxId,
      address: userAddress,
      canMessage: rawClient.canMessage.bind(rawClient),
      conversations: rawClient.conversations,
    };
  }, [rawClient, userAddress]);

  const canCollaborate = useMemo(() => !!client, [client]);

  // Listen for invites
  useEffect(() => {
    if (!client) return;

    let stopStream: (() => void) | undefined;

    const startStream = async () => {
      try {
        // Attempt to use streamAllMessages if available on the client
        // Note: We cast to any because the type definition might not be fully updated in our local view
        if ((rawClient as any).conversations && typeof (rawClient as any).conversations.streamAllMessages === 'function') {
          stopStream = await (rawClient as any).conversations.streamAllMessages(async (message: DecodedMessage) => {
            try {
              if (message.senderInboxId === rawClient.inboxId) return;
              const content = typeof message.content === 'string' ? message.content : String(message.content);
              // Simple check before parsing
              if (!content.includes('"type":"invite"')) return;

              const parsed = JSON.parse(content) as CollaborationMessage;
              if (parsed.type === 'invite') {
                if (debugLoggingEnabled) {
                  console.log(`[XMTP Incoming Invite]`, parsed.payload);
                }
                console.log("Received invite:", parsed.payload);
                setInviteDetails(parsed.payload);
                setInviteModalOpen(true);
              }
            } catch (e) {
              // Ignore parse errors
            }
          });
        } else {
          console.warn("streamAllMessages not found on client.conversations");
        }
      } catch (e) {
        console.warn("Failed to start invite stream", e);
      }
    };

    startStream();

    return () => {
      if (stopStream) stopStream();
    };
  }, [rawClient, client]);

  const addContact = useCallback(
    async (value: string) => {
      if (!client) throw new Error('Connect to XMTP first');
      const resolved = await resolveEnsOrAddress(value, ensResolver);
      const alreadyAdded = contacts.find((c) => c.address.toLowerCase() === resolved.address.toLowerCase());
      if (alreadyAdded) return;

      const identifier = { identifierKind: 'Ethereum' as const, identifier: resolved.address };
      console.log('Checking canMessage for:', identifier);
      const canReachMap = await client.canMessage([identifier]);
      console.log('canMessage result map:', canReachMap);

      // Try exact match, then lowercase match
      let canReach = canReachMap.get(resolved.address);
      if (canReach === undefined) {
        canReach = canReachMap.get(resolved.address.toLowerCase());
      }
      console.log(`Reachability for ${resolved.address}:`, canReach);

      if (!canReach) {
        throw new Error('Contact is not reachable on XMTP dev network');
      }
      setContacts((prev) => [...prev, resolved]);
    },
    [client, contacts, ensResolver]
  );

  const removeContact = useCallback((address: string) => {
    setContacts((prev) => prev.filter((c) => c.address.toLowerCase() !== address.toLowerCase()));
  }, []);

  const startCollaboration = useCallback(
    async (notebookId: string, notebookName: string) => {
      if (!client) {
        setSessionError('You need to connect to XMTP first');
        setStatus('error');
        return;
      }
      if (!notebookId) {
        setSessionError('Select a notebook before collaborating');
        setStatus('error');
        return;
      }
      setStatus('starting');
      setSessionError(null);
      try {
        const collabSession = new NotebookCollaborationSession({ notebookId, client, onRemoteUpdate, debugLoggingEnabled });
        await collabSession.start(contacts, notebookName);
        setSession(collabSession);
        setSessionNotebookId(notebookId);
        setSessionTopic(collabSession.topic);
        setStatus('active');
        await dbService.updateNotebook(notebookId, { xmtpTopic: collabSession.topic });
      } catch (err: any) {
        setStatus('error');
        setSessionError(err?.message || 'Failed to start collaboration');
      }
    },
    [client, contacts, onRemoteUpdate]
  );

  const stopCollaboration = useCallback(async () => {
    await session?.stop();
    setSession(null);
    setStatus('idle');
    setSessionError(null);
    setSessionNotebookId(null);
    setSessionTopic(null);
  }, [session]);

  const broadcastLocalUpdate = useCallback(
    async (note: NoteShape) => {
      if (!session || status !== 'active') return;
      await session.broadcast(note);
    },
    [session, status]
  );

  const acceptInvite = useCallback(async () => {
    if (!inviteDetails || !client) return;

    // Add inviter to contacts
    const inviterContact: CollaborationContact = {
      address: inviteDetails.inviterAddress,
      label: inviteDetails.inviterName || 'Inviter'
    };

    // Check if already in contacts, if not add
    setContacts(prev => {
      if (prev.find(c => c.address.toLowerCase() === inviterContact.address.toLowerCase())) return prev;
      return [...prev, inviterContact];
    });

    // Close modal
    setInviteModalOpen(false);

    // Start collaboration (joining)
    // We pass the inviter as the contact (via state update above, but state update is async)
    // So we should pass it explicitly or wait?
    // startCollaboration uses `contacts` from closure.
    // We need to pass the contact list explicitly to startCollaboration or update it to accept overrides.
    // Or just call session.start directly?
    // Better to reuse startCollaboration but we need to ensure contacts are up to date.
    // Actually, startCollaboration reads `contacts` from scope.
    // If we call it immediately, `contacts` will be old.

    // Let's modify startCollaboration to accept optional contacts override?
    // Or just manually do it here.

    try {
      setStatus('starting');
      const collabSession = new NotebookCollaborationSession({ notebookId: inviteDetails.notebookId, client, onRemoteUpdate, debugLoggingEnabled });
      // We join with the inviter
      await collabSession.start([inviterContact], inviteDetails.notebookName);
      setSession(collabSession);
      setSessionNotebookId(inviteDetails.notebookId);
      setSessionTopic(collabSession.topic);
      setStatus('active');

      // Update or create notebook locally
      const existing = await dbService.updateNotebook(inviteDetails.notebookId, { xmtpTopic: collabSession.topic });
      if (!existing) {
        const timestamp = Date.now();
        await dbService.createReplicaNotebook({
          id: inviteDetails.notebookId,
          name: inviteDetails.notebookName,
          createdAt: timestamp,
          updatedAt: timestamp,
          xmtpTopic: collabSession.topic
        });
      }
    } catch (err: any) {
      setStatus('error');
      setSessionError(err?.message || 'Failed to join collaboration');
    }
  }, [inviteDetails, client, onRemoteUpdate]);

  const rejectInvite = useCallback(() => {
    setInviteModalOpen(false);
    setInviteDetails(null);
  }, []);

  return {
    contacts,
    status,
    sessionNotebookId,
    sessionTopic,
    error: sessionError,
    canCollaborate,
    addContact,
    removeContact,
    startCollaboration,
    stopCollaboration,
    broadcastLocalUpdate,
    // Invite props
    inviteModalOpen,
    inviteDetails,
    acceptInvite,
    rejectInvite
  };
}
