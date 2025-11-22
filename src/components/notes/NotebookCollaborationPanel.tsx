import { useState } from 'react';
import { Users, MessageCircle, X, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CollaborationContact } from '@/lib/collaboration/types';
import { CollaborationStatus } from '@/hooks/useNotebookCollaboration';

interface NotebookCollaborationPanelProps {
  notebookName?: string;
  contacts: CollaborationContact[];
  sessionTopic?: string | null;
  status: CollaborationStatus;
  error?: string | null;
  isXmtpConnected: boolean;
  onAddContact: (value: string) => Promise<void>;
  onRemoveContact: (address: string) => void;
  onStartCollaboration: () => Promise<void>;
  onStopCollaboration: () => Promise<void>;
  xmtpEnv: 'dev' | 'production';
}

export function NotebookCollaborationPanel({
  notebookName,
  contacts,
  sessionTopic,
  status,
  error,
  isXmtpConnected,
  onAddContact,
  onRemoveContact,
  onStartCollaboration,
  onStopCollaboration,
  xmtpEnv,
}: NotebookCollaborationPanelProps) {
  const [contactInput, setContactInput] = useState('');
  const [pendingAdd, setPendingAdd] = useState(false);

  const handleAdd = async () => {
    if (!contactInput.trim()) return;
    setPendingAdd(true);
    try {
      await onAddContact(contactInput);
      setContactInput('');
    } finally {
      setPendingAdd(false);
    }
  };

  const collaborating = status === 'active';
  const isStarting = status === 'starting';

  return (
    <div className="space-y-3 rounded-lg border border-gray-200/70 dark:border-gray-800/70 p-3 bg-white/60 dark:bg-gray-900/60">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <Users className="h-4 w-4 text-gray-500" />
          <div>
            <p className="text-xs uppercase text-gray-500">Collaborate</p>
            <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{notebookName || 'Notebook'}</p>
          </div>
        </div>
        <div className="text-xs text-gray-500 flex items-center space-x-1">
          <ShieldCheck className="h-3 w-3" />
          <span>{xmtpEnv === 'dev' ? 'XMTP dev' : 'XMTP main'}</span>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex space-x-2">
          <Input
            value={contactInput}
            onChange={(e) => setContactInput(e.target.value)}
            placeholder="Add ENS or address"
            className="h-9"
            disabled={!isXmtpConnected || collaborating}
          />
          <Button size="sm" onClick={handleAdd} disabled={!isXmtpConnected || pendingAdd || collaborating}>
            Add
          </Button>
        </div>
        {!isXmtpConnected && (
          <p className="text-xs text-amber-600 dark:text-amber-400">Connect to XMTP dev to invite collaborators.</p>
        )}
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>

      <div className="space-y-1 max-h-28 overflow-y-auto pr-1">
        {contacts.length === 0 && (
          <p className="text-xs text-gray-500">Add contacts by ENS to start a shared chat.</p>
        )}
        {contacts.map((contact) => (
          <div
            key={contact.address}
            className="flex items-center justify-between text-xs bg-gray-100 dark:bg-gray-800 rounded-md px-2 py-1"
          >
            <div>
              <p className="font-mono text-[11px]">{contact.address}</p>
              {contact.ensName && <p className="text-[11px] text-gray-500">{contact.ensName}</p>}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => onRemoveContact(contact.address)}
              disabled={collaborating}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <div className="text-xs text-gray-500 flex items-center space-x-1">
          <MessageCircle className="h-3 w-3" />
          {collaborating && sessionTopic ? (
            <span className="truncate" title={sessionTopic}>
              {sessionTopic}
            </span>
          ) : (
            <span>Start a collab chat</span>
          )}
        </div>
        {collaborating ? (
          <Button size="sm" variant="secondary" onClick={onStopCollaboration}>
            Stop
          </Button>
        ) : (
          <Button size="sm" onClick={onStartCollaboration} disabled={!isXmtpConnected || contacts.length === 0 || isStarting}>
            {isStarting ? 'Starting…' : 'Collaborate'}
          </Button>
        )}
      </div>
    </div>
  );
}
