import { X } from 'lucide-react';
import { Note } from '../../lib/db';

interface EditorTabsProps {
  notes: Note[]; // Full list of notes in the current notebook
  openNoteIds: string[];
  activeNoteId: string | null;
  onSelectTab: (noteId: string) => void;
  onCloseTab: (noteId: string) => void;
}

export function EditorTabs({
  notes,
  openNoteIds,
  activeNoteId,
  onSelectTab,
  onCloseTab,
}: EditorTabsProps) {
  
  // Helper to get note title, falling back to 'Untitled' or ID if not found
  const getNoteTitle = (id: string): string => {
      const note = notes.find(n => n.id === id);
      return note?.title || 'Untitled';
  };

  const openNotes = openNoteIds.map(id => notes.find(note => note.id === id)).filter((note): note is Note => note !== undefined);

  return (
    <div className="flex border-b border-gray-200 dark:border-yellow-400/50 bg-gray-100 dark:bg-gray-900 overflow-x-auto scrollbar-thin scrollbar-thumb-gray-300 hover:scrollbar-thumb-gray-400 dark:scrollbar-thumb-gray-600 dark:hover:scrollbar-thumb-gray-500">
      {openNotes.map((note) => (
        <div
          key={note.id}
          className={`flex items-center px-4 py-2 border-r border-gray-200 dark:border-gray-700 cursor-pointer whitespace-nowrap text-sm ${activeNoteId === note.id 
            ? 'bg-white dark:bg-gray-950 text-gray-900 dark:text-yellow-100 font-medium border-b-2 border-yellow-400 -mb-px'
            : 'bg-gray-100 dark:bg-gray-900 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-800'}`}
          onClick={() => onSelectTab(note.id)}
        >
          <span className="mr-2 truncate">{note.title || 'Untitled'}</span>
          <button
            onClick={(e) => { e.stopPropagation(); onCloseTab(note.id); }}
            className="ml-2 p-0.5 rounded hover:bg-gray-300 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            aria-label={`Close tab ${note.title || 'Untitled'}`}
            title="Close tab"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
      {/* Optional: Add a flexible spacer or a button to show more tabs if overflow happens */}
    </div>
  );
} 