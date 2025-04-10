import { useState, useEffect, useRef, useCallback } from 'react';
import { Sidebar, SidebarHandle } from './components/notes/Sidebar';
import { Editor } from './components/notes/Editor';
import { EditorTabs } from './components/notes/EditorTabs';
import { Note, Notebook, Folder, dbService, DB_NAME } from './lib/db';
import { Client } from '@xmtp/xmtp-js';
import './App.css';
import { Book } from 'lucide-react';

function App() {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [selectedNotebookId, setSelectedNotebookId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [openNoteIds, setOpenNoteIds] = useState<string[]>([]);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [_xmtpClient, setXmtpClient] = useState<Client | null>(null);
  const [_userAddress, setUserAddress] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDbBlocked, setIsDbBlocked] = useState(false);
  const [toastMessage, setToastMessage] = useState<{title: string, description: string, variant?: 'default' | 'destructive'} | null>(null);
  const [draggedNoteId, setDraggedNoteId] = useState<string | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const [activeColumn, setActiveColumn] = useState<'notebooks' | 'notes' | 'editor'>('notes');

  const notesColumnRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const editorTitleInputRef = useRef<HTMLInputElement>(null);
  const editorTextAreaRef = useRef<HTMLTextAreaElement>(null);

  const sidebarRef = useRef<SidebarHandle>(null);
  const notebooksListRef = useRef<HTMLUListElement>(null);

  const getNoteById = (id: string | null): Note | null => {
      if (!id) return null;
      return notes.find(note => note.id === id) || null;
  }
  const activeNote = getNoteById(activeNoteId);

  const showToast = (title: string, description: string, variant: 'default' | 'destructive' = 'default') => {
    setToastMessage({ title, description, variant });
    setTimeout(() => setToastMessage(null), 3000);
  };

  const handleCreateNote = useCallback(async (folderId: string | null = null) => {
    if (!selectedNotebookId) {
        showToast('Error', 'Please select a notebook first', 'destructive');
        return null;
    }
    try {
      console.log(`Creating note in folder: ${folderId}`);
      const newNote = await dbService.createNote({
        notebookId: selectedNotebookId!,
        title: 'Untitled',
        content: '',
        folderId: folderId
      });

      setNotes(prevNotes => [newNote, ...prevNotes].sort((a,b) => b.updatedAt - a.updatedAt));
      setOpenNoteIds(prev => [...new Set([...prev, newNote.id])]);
      setActiveNoteId(newNote.id);

      setTimeout(() => {
        sidebarRef.current?.focusItem('note', newNote.id);
        setTimeout(() => editorTitleInputRef.current?.focus(), 50);
      }, 0);

      showToast('Success', 'New note created');
      return newNote;
    } catch (error) {
      console.error('Failed to create note:', error);
      showToast('Error', 'Failed to create note', 'destructive');
      return null;
    }
  }, [selectedNotebookId, showToast]);

  useEffect(() => {
    const handleGlobalKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const shiftPressed = e.shiftKey;
        let nextColumn: 'notebooks' | 'notes' | 'editor' | null = null;

        if (shiftPressed) {
          if (activeColumn === 'editor') nextColumn = 'notes';
          else if (activeColumn === 'notes') nextColumn = 'notebooks';
          else if (activeColumn === 'notebooks') nextColumn = 'editor';
        } else {
          if (activeColumn === 'notebooks') nextColumn = 'notes';
          else if (activeColumn === 'notes') nextColumn = 'editor';
          else if (activeColumn === 'editor') nextColumn = 'notebooks';
        }

        if (nextColumn) {
          focusColumn(nextColumn);
        }
      }
    };

    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => {
      document.removeEventListener('keydown', handleGlobalKeyDown);
    };
  }, [activeColumn, selectedNotebookId, activeNoteId]);

  const focusColumn = (column: 'notebooks' | 'notes' | 'editor') => {
    setActiveColumn(column);
    if (column === 'notebooks') {
        const targetButton = notebooksListRef.current?.querySelector(
            selectedNotebookId ? `button[data-notebook-id="${selectedNotebookId}"]` : 'button'
        ) as HTMLButtonElement | null;
        targetButton?.focus();
    } else if (column === 'notes') {
        sidebarRef.current?.focusItem(activeNoteId ? 'note' : 'folder', activeNoteId);
    } else if (column === 'editor') {
        if (activeNote) {
            editorTitleInputRef.current?.focus() || editorTextAreaRef.current?.focus();
        } else {
            editorRef.current?.focus();
        }
    }
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
          setOpenNoteIds([]);
          setActiveNoteId(null);
          setFolders([]);
          setIsLoading(false);
          return;
      }

      setIsLoading(true);
      try {
        const notebookFolders = await dbService.getAllFolders(selectedNotebookId);
        setFolders(notebookFolders);
        
        const notebookNotes = await dbService.getAllNotes(selectedNotebookId);
        setNotes(notebookNotes);

        const validOpenNoteIds = openNoteIds.filter(id => notebookNotes.some(n => n.id === id));
        setOpenNoteIds([...new Set(validOpenNoteIds)]);

        if (activeNoteId && !validOpenNoteIds.includes(activeNoteId)) {
            setActiveNoteId(validOpenNoteIds[0] || null);
        } else if (!activeNoteId && validOpenNoteIds.length > 0) {
            setActiveNoteId(validOpenNoteIds[0]);
        }

      } catch (error) {
        console.error('Failed to load notes for notebook:', error);
        showToast('Error', 'Failed to load notes', 'destructive');
        setNotes([]);
        setOpenNoteIds([]);
        setActiveNoteId(null);
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

  const handleSelectNote = (note: Note) => {
      if (!note) return;
      if (!openNoteIds.includes(note.id)) {
          setOpenNoteIds(prev => [...new Set([...prev, note.id])]);
      }
      setActiveNoteId(note.id);
  };

  const handleCloseTab = (noteIdToClose: string) => {
      setOpenNoteIds(prev => prev.filter(id => id !== noteIdToClose));
      if (activeNoteId === noteIdToClose) {
          const currentIndex = openNoteIds.indexOf(noteIdToClose);
          const nextActiveId = openNoteIds[currentIndex - 1] || openNoteIds[currentIndex + 1] || null;
          const remainingOpenIds = openNoteIds.filter(id => id !== noteIdToClose);
          setActiveNoteId(remainingOpenIds.find(id => id === nextActiveId) || remainingOpenIds[0] || null);
      }
  };

  const handleUpdateNote = async (id: string, updates: Partial<Omit<Note, 'id' | 'createdAt' | 'updatedAt' | 'notebookId'>>) => {
    try {
      const updatedNote = await dbService.updateNote(id, updates);

      if (updatedNote) {
        setNotes(notes.map(note => note.id === id ? updatedNote : note));
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
      setNotes(updatedNotes.sort((a, b) => b.updatedAt - a.updatedAt));

      if (openNoteIds.includes(id)) {
          handleCloseTab(id);
      }

      showToast('Success', 'Note deleted');
    } catch (error) {
      console.error('Failed to delete note:', error);
      showToast('Error', 'Failed to delete note', 'destructive');
    }
  };

  const handleCreateFolder = async (name: string, parentFolderId: string | null) => {
    if (!selectedNotebookId) {
        showToast('Error', 'Please select a notebook first', 'destructive');
        return;
    }
    try {
      const newFolder = await dbService.createFolder({
        notebookId: selectedNotebookId!,
        name,
        parentFolderId,
      });

      setFolders([...folders, newFolder]);
      showToast('Success', 'New folder created');
    } catch (error) {
      console.error('Failed to create folder:', error);
      showToast('Error', 'Failed to create folder', 'destructive');
    }
  };

  const handleDeleteFolder = async (folderId: string) => {
    try {
      await dbService.deleteFolder(folderId);
      
      setFolders(folders.filter(folder => folder.id !== folderId));
      
      if (selectedNotebookId) {
        const updatedNotes = await dbService.getAllNotes(selectedNotebookId);
        setNotes(updatedNotes);
      }
      
      showToast('Success', 'Folder deleted');
    } catch (error) {
      console.error('Failed to delete folder:', error);
      showToast('Error', 'Failed to delete folder', 'destructive');
    }
  };

  const handleUpdateFolder = async (folderId: string, updates: Partial<Omit<Folder, 'id' | 'createdAt' | 'updatedAt' | 'notebookId'>>) => {
    try {
      const updatedFolder = await dbService.updateFolder(folderId, updates);
      
      if (updatedFolder) {
        setFolders(folders.map(folder => folder.id === folderId ? updatedFolder : folder));
        showToast('Success', 'Folder updated');
      }
    } catch (error) {
      console.error('Failed to update folder:', error);
      showToast('Error', 'Failed to update folder', 'destructive');
    }
  };

  const handleMoveFolder = async (folderId: string, targetParentFolderId: string | null) => {
    try {
      const updatedFolder = await dbService.moveFolder(folderId, targetParentFolderId);
      if (updatedFolder) {
        setFolders(prevFolders => {
          const otherFolders = prevFolders.filter(f => f.id !== folderId);
          return [...otherFolders, updatedFolder].sort((a, b) => a.name.localeCompare(b.name));
        });
        showToast('Success', 'Folder moved successfully');
      } else {
        console.warn(`Move of folder ${folderId} to ${targetParentFolderId} was disallowed or failed.`);
      }
    } catch (error) {
      console.error('Failed to move folder:', error);
      showToast('Error', 'Failed to move folder', 'destructive');
    }
  };

  const handleMoveNoteToFolder = async (noteId: string, targetFolderId: string | null) => {
    try {
      const updatedNote = await dbService.moveNoteToFolder(noteId, targetFolderId);
      
      if (updatedNote) {
        setNotes(notes.map(note => note.id === noteId ? updatedNote : note));
        showToast('Success', 'Note moved successfully');
      }
    } catch (error) {
      console.error('Failed to move note:', error);
      showToast('Error', 'Failed to move note', 'destructive');
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

  const handleXmtpConnect = (client: Client, address: string) => {
      console.log("App: XMTP Connected", { address });
      setXmtpClient(client);
      setUserAddress(address);
  };

  const handleXmtpDisconnect = () => {
      console.log("App: XMTP Disconnected");
      setXmtpClient(null);
      setUserAddress(null);
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
          <div
            className="w-1/4 min-w-[200px] max-w-[300px] border-r flex flex-col"
            onFocusCapture={() => setActiveColumn('notebooks')}
          >
            <Sidebar
              ref={sidebarRef}
              onXmtpConnect={handleXmtpConnect}
              onXmtpDisconnect={handleXmtpDisconnect}
              notebooks={notebooks}
              selectedNotebookId={selectedNotebookId}
              notes={notes}
              folders={folders}
              selectedNoteId={activeNoteId}
              onSelectNotebook={setSelectedNotebookId}
              onCreateNotebook={handleCreateNotebook}
              onSelectNote={handleSelectNote}
              onCreateNote={handleCreateNote}
              onDeleteNote={handleDeleteNote}
              onCreateFolder={handleCreateFolder}
              onDeleteFolder={handleDeleteFolder}
              onUpdateFolder={handleUpdateFolder}
              onMoveNoteToFolder={handleMoveNoteToFolder}
              onMoveFolder={handleMoveFolder}
              isLoading={isLoading}
              containerRef={notesColumnRef}
              editorTitleInputRef={editorTitleInputRef}
            />
          </div>
          
          <div 
            className="flex-1 flex flex-col"
            ref={editorRef}
            tabIndex={0}
            onFocus={() => setActiveColumn('editor')}
          >
            {isLoading ? (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                    Loading...
                </div>
            ) : openNoteIds.length > 0 ? (
                <>
                    <EditorTabs 
                        notes={notes}
                        openNoteIds={openNoteIds}
                        activeNoteId={activeNoteId}
                        onSelectTab={setActiveNoteId}
                        onCloseTab={handleCloseTab}
                    />
                    <div className="flex-1 overflow-auto">
                        <Editor
                          note={activeNote}
                          onUpdateNote={handleUpdateNote}
                          titleInputRef={editorTitleInputRef}
                          textAreaRef={editorTextAreaRef}
                        />
                    </div>
                </>
            ) : (
                 <div className="flex items-center justify-center h-full text-muted-foreground">
                    Select a note to open it.
                </div>
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
