import { useCallback, useMemo, useState } from 'react';
import { resolveEnsOrAddress, type EnsResolver } from '@/lib/collaboration/contacts';
import { NotebookCollaborationSession, type NoteShape, type XmtpClientLike } from '@/lib/collaboration/notebookCollaboration';
import { CollaborationContact, CrdtUpdatePayload } from '@/lib/collaboration/types';

export type CollaborationStatus = 'idle' | 'starting' | 'active' | 'error';

interface UseNotebookCollaborationProps {
  client: XmtpClientLike | null;
  onRemoteUpdate: (update: CrdtUpdatePayload) => Promise<void> | void;
  ensResolver?: EnsResolver;
}

export function useNotebookCollaboration({ client, onRemoteUpdate, ensResolver }: UseNotebookCollaborationProps) {
  const [contacts, setContacts] = useState<CollaborationContact[]>([]);
  const [status, setStatus] = useState<CollaborationStatus>('idle');
  const [sessionNotebookId, setSessionNotebookId] = useState<string | null>(null);
  const [sessionTopic, setSessionTopic] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [session, setSession] = useState<NotebookCollaborationSession | null>(null);

  const canCollaborate = useMemo(() => !!client, [client]);

  const addContact = useCallback(
    async (value: string) => {
      if (!client) throw new Error('Connect to XMTP first');
      const resolved = await resolveEnsOrAddress(value, ensResolver);
      const alreadyAdded = contacts.find((c) => c.address.toLowerCase() === resolved.address.toLowerCase());
      if (alreadyAdded) return;
      const canReach = await client.canMessage(resolved.address);
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
    async (notebookId: string) => {
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
        const collabSession = new NotebookCollaborationSession({ notebookId, client, onRemoteUpdate });
        await collabSession.start(contacts);
        setSession(collabSession);
        setSessionNotebookId(notebookId);
        setSessionTopic(collabSession.topic);
        setStatus('active');
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
  };
}
