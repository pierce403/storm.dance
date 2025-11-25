import React, { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Loader2, Wifi, WifiOff, AlertCircle } from 'lucide-react';

interface XmtpConnectionModalProps {
    isOpen: boolean;
    onClose: () => void;
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    networkEnv: 'dev' | 'production';
    onConnect: () => void;
    onDisconnect: () => void;
    onToggleNetwork: () => void;
    address: string | null;
    errorMsg?: string | null;
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
}: XmtpConnectionModalProps) {
    const isConnecting = status === 'connecting';
    const isConnected = status === 'connected';

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
                                <span className="text-xs text-muted-foreground">Wallet Address</span>
                                <code className="text-xs bg-muted p-1 rounded break-all">{address}</code>
                            </div>
                        )}
                        {errorMsg && (
                            <div className="text-xs text-red-500 mt-2">
                                {errorMsg}
                            </div>
                        )}
                    </div>
                </div>

                <DialogFooter className="sm:justify-between">
                    <Button variant="outline" onClick={onClose}>
                        Close
                    </Button>
                    {isConnected ? (
                        <Button variant="destructive" onClick={onDisconnect}>
                            Disconnect
                        </Button>
                    ) : (
                        <Button onClick={onConnect} disabled={isConnecting}>
                            {isConnecting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            Connect
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
