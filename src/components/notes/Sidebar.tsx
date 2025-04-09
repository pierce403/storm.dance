import { Plus, Trash2 } from 'lucide-react';
import { Note } from '../../lib/db';

interface SidebarProps {
  notes: Note[];
  selectedNoteId: string | null;
  onSelectNote: (note: Note) => void;
  onCreateNote: () => void;
  onDeleteNote: (noteId: string) => void;
}

export function Sidebar({
  notes,
  selectedNoteId,
  onSelectNote,
  onCreateNote,
  onDeleteNote,
}: SidebarProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="p-4 flex justify-between items-center">
        <h2 className="text-lg font-semibold">Notes</h2>
        <button 
          className="p-2 rounded-md hover:bg-gray-100"
          onClick={onCreateNote} 
          title="Create new note"
        >
          <Plus className="h-5 w-5" />
        </button>
      </div>
      <div className="border-t"></div>
      <div className="flex-1 overflow-auto">
        <div className="p-2">
          {notes.length === 0 ? (
            <p className="text-center text-gray-500 p-4">No notes yet</p>
          ) : (
            <ul className="space-y-1">
              {notes.map((note) => (
                <li key={note.id} className="relative group">
                  <button
                    className={`w-full text-left px-3 py-2 rounded-md ${
                      selectedNoteId === note.id ? "bg-gray-200" : "hover:bg-gray-100"
                    }`}
                    onClick={() => onSelectNote(note)}
                  >
                    <span className="block truncate">{note.title || 'Untitled'}</span>
                  </button>
                  <button
                    className="absolute right-2 top-2 p-1 rounded-md opacity-0 group-hover:opacity-100 hover:bg-gray-200"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteNote(note.id);
                    }}
                    title="Delete note"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
