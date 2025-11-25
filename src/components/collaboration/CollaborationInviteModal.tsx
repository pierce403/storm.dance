import React from 'react';
import { Button } from '@/components/ui/button';
import { X, Check } from 'lucide-react';

interface CollaborationInviteModalProps {
    isOpen: boolean;
    inviterName?: string;
    notebookName: string;
    onAccept: () => void;
    onReject: () => void;
}

export function CollaborationInviteModal({
    isOpen,
    inviterName,
    notebookName,
    onAccept,
    onReject,
}: CollaborationInviteModalProps) {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 animate-in fade-in duration-200">
            <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl p-6 max-w-sm w-full mx-4 border border-gray-200 dark:border-gray-800">
                <div className="text-center space-y-4">
                    <div className="mx-auto w-12 h-12 bg-blue-100 dark:bg-blue-900/30 rounded-full flex items-center justify-center">
                        <span className="text-2xl">🤝</span>
                    </div>

                    <div>
                        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                            Collaboration Invite
                        </h3>
                        <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
                            <span className="font-medium text-gray-900 dark:text-gray-200">
                                {inviterName || 'Someone'}
                            </span>{' '}
                            invited you to collaborate on the notebook{' '}
                            <span className="font-medium text-gray-900 dark:text-gray-200">
                                "{notebookName}"
                            </span>
                        </p>
                    </div>

                    <div className="flex gap-3 pt-2">
                        <Button
                            variant="outline"
                            className="flex-1"
                            onClick={onReject}
                        >
                            <X className="w-4 h-4 mr-2" />
                            Reject
                        </Button>
                        <Button
                            className="flex-1 bg-blue-600 hover:bg-blue-700 text-white"
                            onClick={onAccept}
                        >
                            <Check className="w-4 h-4 mr-2" />
                            Accept
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}
