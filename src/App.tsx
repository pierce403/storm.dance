import { useState, useEffect, Dispatch, SetStateAction } from 'react';
import { Sidebar } from './components/notes/Sidebar';
import { Editor } from './components/notes/Editor';
import { Note, Notebook, dbService, CreateNoteInput, DB_NAME } from './lib/db';
import './App.css';

function App() {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [selectedNotebookId, setSelectedNotebookId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDbBlocked, setIsDbBlocked] = useState(false);
  const [toastMessage, setToastMessage] = useState<{title: string, description: string, variant?: 'default' | 'destructive'} | null>(null);

  const showToast = (title: string, description: string, variant: 'default' | 'destructive' = 'default') => {
    setToastMessage({ title, description, variant });
    setTimeout(() => setToastMessage(null), 3000);
  };

  useEffect(() => {
    const loadInitialData = async () => {
      setIsLoading(true);
      try {
        const defaultNotebook = await dbService._ensureDefaultNotebook();
        const allNotebooks = await dbService.getAllNotebooks();
        setNotebooks(allNotebooks);

        if (!selectedNotebookId) {
            setSelectedNotebookId(defaultNotebook.id);
        } else {
            const selectedExists = allNotebooks.some(nb => nb.id === selectedNotebookId);
            if (!selectedExists) {
                setSelectedNotebookId(defaultNotebook.id);
            }
        }
        setIsDbBlocked(false);

      } catch (error) {
        console.error('Failed initialization:', error);
        setIsDbBlocked(true);
        showToast('Error', 'Failed to initialize database. Another tab might be blocking an update.', 'destructive');
      } finally {
      }
    };
    loadInitialData();
  }, []);

  useEffect(() => {
    const loadNotes = async () => {
      if (!selectedNotebookId) {
          setNotes([]);
          setSelectedNote(null);
          setIsLoading(false);
          return;
      }

      setIsLoading(true);
      try {
        const notebookNotes = await dbService.getAllNotes(selectedNotebookId);
        setNotes(notebookNotes);

        const currentSelectedNoteExists = notebookNotes.some(n => n.id === selectedNote?.id);

        if (selectedNote && !currentSelectedNoteExists) {
           setSelectedNote(null);
        } else if (!selectedNote && notebookNotes.length > 0) {
          setSelectedNote(notebookNotes[0]);
        } else if (notebookNotes.length === 0) {
            setSelectedNote(null);
        }

      } catch (error) {
        console.error('Failed to load notes for notebook:', error);
        showToast('Error', 'Failed to load notes', 'destructive');
        setNotes([]);
        setSelectedNote(null);
      } finally {
        setIsLoading(false);
      }
    };

    loadNotes();
  }, [selectedNotebookId]);

  const handleCreateNotebook = async (name: string): Promise<Notebook | null> => {
      try {
          const newNotebook = await dbService.createNotebook({ name });
          setNotebooks([newNotebook, ...notebooks]);
          setSelectedNotebookId(newNotebook.id);
          showToast('Success', `Notebook '${name}' created`);
          return newNotebook;
      } catch (error) {
          console.error('Failed to create notebook:', error);
          showToast('Error', 'Failed to create notebook', 'destructive');
          return null;
      }
  }

  const handleCreateNote = async () => {
    if (!selectedNotebookId) {
        showToast('Error', 'Please select a notebook first', 'destructive');
        return;
    }
    try {
      const newNote = await dbService.createNote({
        notebookId: selectedNotebookId,
        title: 'Untitled',
        content: '',
      });

      setNotes([newNote, ...notes]);
      setSelectedNote(newNote);

      showToast('Success', 'New note created');
    } catch (error) {
      console.error('Failed to create note:', error);
      showToast('Error', 'Failed to create note', 'destructive');
    }
  };

  const handleUpdateNote = async (id: string, updates: Partial<Omit<Note, 'id' | 'createdAt' | 'updatedAt' | 'notebookId'>>) => {
    try {
      const updatedNote = await dbService.updateNote(id, updates);

      if (updatedNote) {
        setNotes(notes.map(note => note.id === id ? updatedNote : note));

        if (selectedNote && selectedNote.id === id) {
          setSelectedNote(updatedNote);
        }
      }
    } catch (error) {
      console.error('Failed to update note:', error);
      showToast('Error', 'Failed to update note', 'destructive');
    }
  };

  const handleDeleteNote = async (id: string) => {
    try {
      await dbService.deleteNote(id);

      const updatedNotes = notes.filter(note => note.id !== id);
      setNotes(updatedNotes);

      if (selectedNote && selectedNote.id === id) {
        const oldIndex = notes.findIndex(note => note.id === id);
        const newSelectedNote = updatedNotes[oldIndex] || updatedNotes[oldIndex - 1] || (updatedNotes.length > 0 ? updatedNotes[0] : null);
        setSelectedNote(newSelectedNote);
      }

      showToast('Success', 'Note deleted');
    } catch (error) {
      console.error('Failed to delete note:', error);
      showToast('Error', 'Failed to delete note', 'destructive');
    }
  };

  const handleClearStorage = async () => {
    console.log(`Attempting to delete IndexedDB database: ${DB_NAME}`);
    try {
      await indexedDB.deleteDatabase(DB_NAME);
      console.log("IndexedDB deleted successfully.");
      showToast('Storage Cleared', 'Reloading application...');
      setTimeout(() => {
          window.location.reload();
      }, 1500);
    } catch (error) {
      console.error("Failed to delete IndexedDB:", error);
      showToast('Error', 'Failed to clear storage. Please close all tabs and try manually in browser dev tools.', 'destructive');
    }
  };

  if (isDbBlocked) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
        <div className="bg-white p-8 rounded-lg shadow-xl text-center">
          <h2 className="text-xl font-bold mb-4">Database Update Required</h2>
          <p className="mb-6 text-gray-700">
            storm.dance needs to update its database schema, but another tab might be blocking it.
            Please close any other open tabs running this application.
          </p>
          <p className="mb-6 text-gray-700">
            If the issue persists, you can clear the local storage. <strong className="text-red-600">This will delete all your current notes.</strong>
          </p>
          <button
            onClick={handleClearStorage}
            className="px-6 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
          >
            Clear Storage & Reload
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-background font-sans antialiased">
      <header className="border-b p-4">
        <h1 className="text-2xl font-bold">storm.dance</h1>
      </header>
      
      <main className="flex-1 overflow-hidden">
        <div className="flex h-full">
          <div className="w-1/4 min-w-[200px] max-w-[300px] border-r">
            <Sidebar
              notebooks={notebooks}
              selectedNotebookId={selectedNotebookId}
              notes={notes}
              selectedNoteId={selectedNote?.id || null}
              onSelectNotebook={setSelectedNotebookId}
              onCreateNotebook={handleCreateNotebook}
              onSelectNote={setSelectedNote}
              onCreateNote={handleCreateNote}
              onDeleteNote={handleDeleteNote}
              isLoading={isLoading}
            />
          </div>
          
          <div className="flex-1">
            {isLoading ? (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                    Loading...
                </div>
            ) : (
                <Editor
                  note={selectedNote}
                  onUpdateNote={handleUpdateNote}
                />
            )}
          </div>
        </div>
      </main>
      
      {toastMessage && (
        <div className={`fixed bottom-4 right-4 p-4 rounded-md shadow-lg ${
          toastMessage.variant === 'destructive' ? 'bg-red-500 text-white' : 'bg-green-500 text-white'
        }`}>
          <h3 className="font-bold">{toastMessage.title}</h3>
          <p>{toastMessage.description}</p>
        </div>
      )}
    </div>
  );
}

export default App;
