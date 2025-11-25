import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';

interface CreateNotebookModalProps {
    isOpen: boolean;
    onClose: () => void;
    onCreate: (name: string) => void;
}

const ADJECTIVES = [
    'Cosmic', 'Electric', 'Silent', 'Ancient', 'Neon', 'Golden', 'Silver', 'Crimson', 'Azure', 'Emerald',
    'Mystic', 'Solar', 'Lunar', 'Stellar', 'Radiant', 'Shadow', 'Crystal', 'Iron', 'Velvet', 'Thunder',
    'Hidden', 'Lost', 'Found', 'Brave', 'Wild', 'Calm', 'Bright', 'Dark', 'Swift', 'Slow'
];

const SUBJECTS = [
    'Notebook', 'Chronicle', 'Journal', 'Ledger', 'Grimoire', 'Codex', 'Archive', 'Vault', 'Nexus', 'Horizon',
    'Echo', 'Spark', 'Pulse', 'Wave', 'Storm', 'Dance', 'Dream', 'Vision', 'Memory', 'Thought',
    'Ideas', 'Plans', 'Notes', 'Drafts', 'Sketches', 'Lists', 'Tasks', 'Goals', 'Secrets', 'Stories'
];

export function CreateNotebookModal({ isOpen, onClose, onCreate }: CreateNotebookModalProps) {
    const [name, setName] = useState('');

    useEffect(() => {
        if (isOpen) {
            const randomAdjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
            const randomSubject = SUBJECTS[Math.floor(Math.random() * SUBJECTS.length)];
            setName(`${randomAdjective} ${randomSubject}`);
        }
    }, [isOpen]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (name.trim()) {
            onCreate(name.trim());
            onClose();
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
            <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-md p-6 border border-gray-200 dark:border-gray-800">
                <div className="flex justify-between items-center mb-4">
                    <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Create New Notebook</h2>
                    <button
                        onClick={onClose}
                        className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                    >
                        <X size={20} />
                    </button>
                </div>

                <form onSubmit={handleSubmit}>
                    <div className="mb-6">
                        <label htmlFor="notebook-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                            Notebook Name
                        </label>
                        <input
                            id="notebook-name"
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-yellow-400"
                            autoFocus
                            placeholder="Enter notebook name"
                        />
                        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                            We've picked a fun name for you, but feel free to change it!
                        </p>
                    </div>

                    <div className="flex justify-end space-x-3">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={!name.trim()}
                            className="px-4 py-2 text-sm font-medium text-black bg-yellow-400 hover:bg-yellow-500 rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            Create Notebook
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
