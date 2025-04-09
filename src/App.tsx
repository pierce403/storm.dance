import { useState, useEffect } from 'react';
import { Sidebar } from './components/notes/Sidebar';
import { Editor } from './components/notes/Editor';
import { Note, dbService } from './lib/db';
import './App.css';

function App() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [toastMessage, setToastMessage] = useState<{title: string, description: string, variant?: 'default' | 'destructive'} | null>(null);

  const showToast = (title: string, description: string, variant: 'default' | 'destructive' = 'default') => {
    setToastMessage({ title, description, variant });
    setTimeout(() => setToastMessage(null), 3000);
  };

  useEffect(() => {
    const loadNotes = async () => {
      try {
        const allNotes = await dbService.getAllNotes();
        setNotes(allNotes.reverse()); // Show newest notes first
        
        if (allNotes.length > 0 && !selectedNote) {
          setSelectedNote(allNotes[0]);
        }
      } catch (error) {
        console.error('Failed to load notes:', error);
        showToast('Error', 'Failed to load notes', 'destructive');
      }
    };

    loadNotes();
  }, []);

  const handleCreateNote = async () => {
    try {
      const newNote = await dbService.createNote({
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

  const handleUpdateNote = async (id: string, updates: Partial<Note>) => {
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
        setSelectedNote(updatedNotes.length > 0 ? updatedNotes[0] : null);
      }
      
      showToast('Success', 'Note deleted');
    } catch (error) {
      console.error('Failed to delete note:', error);
      showToast('Error', 'Failed to delete note', 'destructive');
    }
  };

  return (
    <div className="flex flex-col h-screen bg-background font-sans antialiased">
      <header className="border-b p-4">
        <h1 className="text-2xl font-bold">storm.dance</h1>
      </header>
      
      <main className="flex-1 overflow-hidden">
        <div className="flex h-full">
          <div className="w-1/4 min-w-[200px] max-w-[300px] border-r">
            <Sidebar
              notes={notes}
              selectedNoteId={selectedNote?.id || null}
              onSelectNote={setSelectedNote}
              onCreateNote={handleCreateNote}
              onDeleteNote={handleDeleteNote}
            />
          </div>
          
          <div className="flex-1">
            <Editor
              note={selectedNote}
              onUpdateNote={handleUpdateNote}
            />
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
