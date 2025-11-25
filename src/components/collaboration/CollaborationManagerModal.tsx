import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Users, MessageCircle, X, ShieldCheck, Loader2 } from 'lucide-react';
import { CollaborationContact } from '@/lib/collaboration/types';
import { CollaborationStatus } from '@/hooks/useNotebookCollaboration';

interface CollaborationManagerModalProps {
    isOpen: boolean;
    onClose: () => void;
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

export function CollaborationManagerModal({
    isOpen,
    onClose,
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
}: CollaborationManagerModalProps) {
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
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                    <DialogTitle>Collaborate on "{notebookName || 'Untitled'}"</DialogTitle>
                    <DialogDescription>
                        Invite others to edit this notebook with you in real-time via XMTP.
                    </DialogDescription>
                </DialogHeader>

                <div className="grid gap-4 py-4">
                    {/* Connection Status */}
                    <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Network:</span>
                        <div className="flex items-center space-x-1">
                            <ShieldCheck className="h-3 w-3" />
                            <span>{xmtpEnv === 'dev' ? 'XMTP dev' : 'XMTP main'}</span>
                        </div>
                    </div>

                    {/* Add Collaborator Input */}
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
                                {pendingAdd ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add'}
                            </Button>
                        </div>
                        {!isXmtpConnected && (
                            <p className="text-xs text-amber-600 dark:text-amber-400">Connect to XMTP to invite collaborators.</p>
                        )}
                        {error && <p className="text-xs text-red-500">{error}</p>}
                    </div>

                    {/* Contact List */}
                    <div className="space-y-1 max-h-[200px] overflow-y-auto pr-1 border rounded-md p-2">
                        {contacts.length === 0 && (
                            <p className="text-xs text-muted-foreground text-center py-2">No collaborators added yet.</p>
                        )}
                        {contacts.map((contact) => (
                            <div
                                key={contact.address}
                                className="flex items-center justify-between text-xs bg-muted/50 rounded-md px-2 py-1"
                            >
                                <div>
                                    <p className="font-mono text-[11px]">{contact.address}</p>
                                    {contact.ensName && <p className="text-[11px] text-muted-foreground">{contact.ensName}</p>}
                                </div>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 hover:text-destructive"
                                    onClick={() => onRemoveContact(contact.address)}
                                    disabled={collaborating}
                                >
                                    <X className="h-3 w-3" />
                                </Button>
                            </div>
                        ))}
                    </div>

                    {/* Session Info */}
                    {collaborating && sessionTopic && (
                        <div className="text-xs text-muted-foreground flex items-center space-x-1">
                            <MessageCircle className="h-3 w-3" />
                            <span className="truncate max-w-[300px]" title={sessionTopic}>
                                Topic: {sessionTopic}
                            </span>
                        </div>
                    )}
                </div>

                <DialogFooter className="sm:justify-between">
                    {collaborating ? (
                        <Button variant="destructive" onClick={onStopCollaboration} className="w-full sm:w-auto">
                            Stop Collaboration
                        </Button>
                    ) : (
                        <Button
                            onClick={onStartCollaboration}
                            disabled={!isXmtpConnected || contacts.length === 0 || isStarting}
                            className="w-full sm:w-auto ml-auto"
                        >
                            {isStarting ? (
                                <>
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Starting...
                                </>
                            ) : 'Start Session'}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
