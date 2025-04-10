import { useState } from 'react';
import { Plus, Trash2, Book, Loader2 } from 'lucide-react';
import { Note, Notebook } from '../../lib/db';
import { XmtpConnect } from '../xmtp/XmtpConnect';
import { Client } from '@xmtp/xmtp-js';

interface SidebarProps {
  onXmtpConnect: (client: Client, address: string) => void;
  onXmtpDisconnect: () => void;
  notebooks: Notebook[];
  selectedNotebookId: string | null;
  notes: Note[];
  selectedNoteId: string | null;
  onSelectNotebook: (notebookId: string) => void;
  onCreateNotebook: (name: string) => Promise<Notebook | null>;
  onSelectNote: (note: Note) => void;
  onCreateNote: () => void;
  onDeleteNote: (noteId: string) => void;
  isLoading: boolean;
}

export function Sidebar({
  onXmtpConnect,
  onXmtpDisconnect,
  notebooks,
  selectedNotebookId,
  notes,
  selectedNoteId,
  onSelectNotebook,
  onCreateNotebook,
  onSelectNote,
  onCreateNote,
  onDeleteNote,
  isLoading,
}: SidebarProps) {

  const [isCreatingNotebook, setIsCreatingNotebook] = useState(false);
  const [newNotebookName, setNewNotebookName] = useState("");

  const handleCreateNotebookClick = async () => {
    if (!newNotebookName.trim()) return;
    setIsCreatingNotebook(true);
    const newNotebook = await onCreateNotebook(newNotebookName.trim());
    if (newNotebook) {
        setNewNotebookName(""); // Clear input on success
    }
    setIsCreatingNotebook(false);
  };

  return (
    <div className="flex flex-col h-full">
      <XmtpConnect 
          onConnect={onXmtpConnect}
          onDisconnect={onXmtpDisconnect}
      />
      <div className="p-4 border-b">
         <h2 className="text-lg font-semibold mb-2 flex items-center">
             <Book className="h-5 w-5 mr-2" /> Notebooks
         </h2>
         {isLoading && notebooks.length === 0 ? (
             <div className="flex items-center justify-center text-sm text-muted-foreground">
                 <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading...
             </div>
         ) : (
             <select
                 className="w-full p-2 border rounded-md mb-2 text-sm"
                 value={selectedNotebookId || ''}
                 onChange={(e) => onSelectNotebook(e.target.value)}
                 disabled={isLoading}
             >
                 {notebooks.map((notebook) => (
                 <option key={notebook.id} value={notebook.id}>
                     {notebook.name}
                 </option>
                 ))}
             </select>
         )}
         <div className="flex space-x-2">
            <input
                type="text"
                placeholder="New notebook name..."
                value={newNotebookName}
                onChange={(e) => setNewNotebookName(e.target.value)}
                className="flex-1 p-2 border rounded-md text-sm"
                disabled={isCreatingNotebook || isLoading}
            />
            <button
                className="p-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 flex items-center text-sm"
                onClick={handleCreateNotebookClick}
                disabled={!newNotebookName.trim() || isCreatingNotebook || isLoading}
                title="Create new notebook"
            >
                 {isCreatingNotebook ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            </button>
         </div>
      </div>
      <div className="flex-1 overflow-hidden flex flex-col">
          <div className="p-4 flex justify-between items-center">
            <h2 className="text-lg font-semibold">Notes</h2>
            <button
              className="p-2 rounded-md hover:bg-gray-100 disabled:opacity-50"
              onClick={onCreateNote}
              title="Create new note"
              disabled={!selectedNotebookId || isLoading}
            >
              <Plus className="h-5 w-5" />
            </button>
          </div>
          <div className="border-t"></div>
          <div className="flex-1 overflow-auto">
            <div className="p-2">
              {isLoading ? (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading Notes...
                </div>
              ) : !selectedNotebookId ? (
                 <p className="text-center text-gray-500 p-4">Select a notebook</p>
              ) : notes.length === 0 ? (
                <p className="text-center text-gray-500 p-4">No notes in this notebook</p>
              ) : (
                <ul className="space-y-1">
                  {notes.map((note) => (
                    <li key={note.id} className="relative group">
                      <button
                        className={`w-full text-left px-3 py-2 rounded-md text-sm ${
                          selectedNoteId === note.id ? "bg-gray-200" : "hover:bg-gray-100"
                        }`}
                        onClick={() => onSelectNote(note)}
                      >
                        <span className="block truncate">{note.title || 'Untitled'}</span>
                      </button>
                      <button
                        className="absolute right-2 top-2 p-1 rounded-md opacity-0 group-hover:opacity-100 hover:bg-red-100 text-red-600"
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
    </div>
  );
}
