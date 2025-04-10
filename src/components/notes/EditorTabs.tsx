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

  return (
    <div className="flex border-b bg-gray-50 overflow-x-auto">
      {openNoteIds.map((noteId) => (
        <div
          key={noteId}
          className={`flex items-center px-4 py-2 border-r cursor-pointer whitespace-nowrap ${
            activeNoteId === noteId
              ? 'bg-white border-b-2 border-blue-500 -mb-[1px]' // Active tab style
              : 'hover:bg-gray-100 text-gray-600' // Inactive tab style
          }`}
          onClick={() => onSelectTab(noteId)}
        >
          <span className="text-sm mr-2 truncate max-w-[150px]">
             {getNoteTitle(noteId)}
          </span>
          <button
            className="p-0.5 rounded hover:bg-gray-300"
            onClick={(e) => {
              e.stopPropagation(); // Prevent selecting tab when closing
              onCloseTab(noteId);
            }}
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