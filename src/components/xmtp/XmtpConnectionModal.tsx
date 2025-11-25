import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Loader2, Wifi, WifiOff, AlertCircle, Copy, Check, Plus } from 'lucide-react';
import type { XmtpEnv } from '@/utils/xmtp-utils';

interface XmtpConnectionModalProps {
    isOpen: boolean;
    onClose: () => void;
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    networkEnv: XmtpEnv;
    onConnect: () => void;
    onDisconnect: () => void;
    onToggleNetwork: () => void;
    address?: string;
    errorMsg?: string | null;
    connectedNotebooksCount: number;
    hasIdentity: boolean;
    onCreateIdentity: () => void;
    activeConversationsCount: number;
    debugLoggingEnabled: boolean;
    setDebugLoggingEnabled: (enabled: boolean) => void;
}

export function XmtpConnectionModal({
    isOpen,
    onClose,
    status,
    networkEnv,
    onConnect,
    onDisconnect,
    onToggleNetwork,
    address,
    errorMsg,
    connectedNotebooksCount,
    hasIdentity,
    onCreateIdentity,
    activeConversationsCount,
    debugLoggingEnabled,
    setDebugLoggingEnabled,
}: XmtpConnectionModalProps) {
    const isConnecting = status === 'connecting';
    const isConnected = status === 'connected';
    const [copied, setCopied] = useState(false);

    const handleCopyAddress = () => {
        if (address) {
            navigator.clipboard.writeText(address);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                    <DialogTitle>XMTP Connection</DialogTitle>
                    <DialogDescription>
                        Connect to the XMTP network to enable secure messaging and collaboration.
                    </DialogDescription>
                </DialogHeader>

                <div className="grid gap-4 py-4">
                    <div className="flex items-center justify-between space-x-2">
                        <Label htmlFor="network-mode" className="flex flex-col space-y-1">
                            <span>Network Environment</span>
                            <span className="font-normal text-xs text-muted-foreground">
                                {networkEnv === 'dev' ? 'Development (dev)' : 'Production (production)'}
                            </span>
                        </Label>
                        <Switch
                            id="network-mode"
                            checked={networkEnv === 'production'}
                            onCheckedChange={onToggleNetwork}
                            disabled={isConnected || isConnecting}
                        />
                    </div>

                    <div className="flex items-center justify-between space-x-2">
                        <Label htmlFor="debug-logging" className="flex flex-col space-y-1">
                            <span>Debug Logging</span>
                            <span className="font-normal text-xs text-muted-foreground">
                                Print messages to console
                            </span>
                        </Label>
                        <Switch
                            id="debug-logging"
                            checked={debugLoggingEnabled}
                            onCheckedChange={setDebugLoggingEnabled}
                        />
                    </div>

                    <div className="flex flex-col space-y-2 p-4 rounded-md bg-muted/50">
                        <div className="flex items-center justify-between">
                            <span className="text-sm font-medium">Status</span>
                            <div className="flex items-center space-x-2">
                                {status === 'connected' && <Wifi size={16} className="text-green-500" />}
                                {status === 'connecting' && <Loader2 size={16} className="animate-spin text-yellow-500" />}
                                {status === 'disconnected' && <WifiOff size={16} className="text-gray-400" />}
                                {status === 'error' && <AlertCircle size={16} className="text-red-500" />}
                                <span className="text-sm capitalize">{status}</span>
                            </div>
                        </div>
                        {address && (
                            <div className="flex flex-col space-y-1 mt-2">
                                <span className="text-xs text-muted-foreground">Connected Identity</span>
                                <div className="flex items-center space-x-2">
                                    <code className="text-xs bg-muted p-1 rounded break-all flex-1">{address}</code>
                                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleCopyAddress}>
                                        {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
                                    </Button>
                                </div>
                            </div>
                        )}

                        {isConnected && (
                            <>
                                <div className="flex justify-between items-center mt-2">
                                    <span className="text-sm">Active Conversations</span>
                                    <span className="font-medium">{activeConversationsCount}</span>
                                </div>
                                <div className="flex justify-between items-center mt-1">
                                    <span className="text-sm">Messages Seen</span>
                                    <span className="font-medium">0</span>
                                </div>
                            </>
                        )}

                        <div className="flex justify-between items-center mt-2">
                            <span className="text-sm">Connected Notebooks</span>
                            <span className="font-medium">{connectedNotebooksCount}</span>
                        </div>
                        {errorMsg && (
                            <div className="text-xs text-red-500 mt-2">
                                {errorMsg}
                            </div>
                        )}
                    </div>
                </div>

                <DialogFooter className="sm:justify-between gap-2">
                    <Button variant="outline" onClick={onClose}>
                        Close
                    </Button>
                    {isConnected ? (
                        <Button variant="destructive" onClick={onDisconnect}>
                            Disconnect
                        </Button>
                    ) : (
                        <div className="flex gap-2">
                            {!hasIdentity && (
                                <Button onClick={onCreateIdentity} disabled={isConnecting} variant="secondary">
                                    <Plus className="mr-2 h-4 w-4" />
                                    New Identity
                                </Button>
                            )}
                            <Button onClick={onConnect} disabled={isConnecting || !hasIdentity}>
                                {isConnecting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                Connect
                            </Button>
                        </div>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
