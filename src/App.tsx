import { useState, useEffect, useRef, useCallback } from 'react';
import { Sidebar, SidebarHandle } from './components/notes/Sidebar';
import { Editor } from './components/notes/Editor';
import { EditorTabs } from './components/notes/EditorTabs';
import { Note, Notebook, Folder, dbService, DB_NAME } from './lib/db';
import type { BrowserClient } from '@/lib/xmtp-browser-sdk';
import { Key, AlertCircle } from 'lucide-react';
import './App.css';
import './DarkTheme.css';
import { decryptBackup } from './lib/cryptoUtils';
import { TopBar } from './components/TopBar';
import { useNotebookCollaboration } from './hooks/useNotebookCollaboration';
import type { CrdtUpdatePayload } from './lib/collaboration/types';

// --- Types for Import --- 
interface ExportedFolder {
  id: string;
  name: string;
  parentPath: string | null;
}
interface ExportedNote {
  id: string;
  folderPath: string | null;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}
interface ExportedData {
  notebook: { id: string; name: string };
  folders: ExportedFolder[];
  notes: ExportedNote[];
}

// --- Import Password Modal --- 
const ImportPasswordModal: React.FC<{ fileName: string; onImport: (password: string) => void; onCancel: () => void }> = ({ fileName, onImport, onCancel }) => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    if (!password) {
      setError("Password cannot be empty.");
      return;
    }
    setError(null);
    onImport(password);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={onCancel}>
      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-xl max-w-md w-full" onClick={e => e.stopPropagation()}>
        <h2 className="text-xl font-semibold mb-4 text-gray-900 dark:text-gray-100">Import Password Required</h2>
        <p className="mb-4 text-sm text-gray-600 dark:text-gray-300">Enter the password used to encrypt the backup file <code className="bg-gray-100 dark:bg-gray-700 p-1 rounded text-xs">{fileName}</code>.</p>
        <div className="relative mb-4">
          <Key className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter Password"
            className="w-full pl-10 pr-3 py-2 border rounded-md text-sm bg-white dark:bg-gray-700 border-gray-300 dark:border-gray-600 placeholder-gray-400 dark:placeholder-gray-500 focus:ring-yellow-400 focus:border-yellow-400 dark:text-gray-100"
            autoFocus
          />
        </div>
        {error && <p className="mb-2 text-xs text-red-600 dark:text-red-400 flex items-center"><AlertCircle size={14} className="mr-1" />{error}</p>}
        <div className="flex justify-end space-x-2">
          <button onClick={onCancel} className="px-4 py-2 bg-gray-200 dark:bg-gray-600 text-gray-800 dark:text-gray-100 rounded hover:bg-gray-300 dark:hover:bg-gray-500">
            Cancel
          </button>
          <button onClick={handleSubmit} className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 dark:bg-yellow-400 dark:text-black dark:hover:bg-yellow-500">
            Import
          </button>
        </div>
      </div>
    </div>
  );
};

function App() {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [selectedNotebookId, setSelectedNotebookId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [openNoteIds, setOpenNoteIds] = useState<string[]>([]);
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [xmtpClient, setXmtpClient] = useState<BrowserClient | null>(null);
  const [userAddress, setUserAddress] = useState<string | null>(null);
  const [xmtpStatus, setXmtpStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [xmtpNetworkEnv, setXmtpNetworkEnv] = useState<'dev' | 'production'>('dev');
  const [isXmtpConnecting, setIsXmtpConnecting] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isDbBlocked, setIsDbBlocked] = useState(false);
  const [toastMessage, setToastMessage] = useState<{ title: string, description: string, variant?: 'default' | 'destructive' } | null>(null);
  const [activeColumn, setActiveColumn] = useState<'notebooks' | 'notes' | 'editor'>('notes');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const savedTheme = localStorage.getItem('theme');
    if (!savedTheme) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return savedTheme === 'dark' ? 'dark' : 'light';
  });

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme');
    const initialTheme = savedTheme === 'dark' ? 'dark' :
      (savedTheme === 'light' ? 'light' :
        (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
    document.documentElement.setAttribute('data-theme', initialTheme);
    document.documentElement.classList.toggle('dark', initialTheme === 'dark');
  }, []);

  const handleRemoteCrdtUpdate = useCallback(async (update: CrdtUpdatePayload) => {
    if (!notebooks.some(nb => nb.id === update.notebookId)) {
      return;
    }

    let noteForDb: Note | null = null;
    setNotes((prevNotes) => {
      const existing = prevNotes.find(n => n.id === update.noteId);
      const merged: Note = existing
        ? { ...existing, title: update.title, content: update.content, updatedAt: update.updatedAt }
        : {
          id: update.noteId,
          notebookId: update.notebookId,
          folderId: null,
          title: update.title,
          content: update.content,
          createdAt: update.updatedAt,
          updatedAt: update.updatedAt,
        };

      noteForDb = merged;
      const filtered = prevNotes.filter(n => n.id !== update.noteId);
      return [...filtered, merged].sort((a, b) => b.updatedAt - a.updatedAt);
    });

    if (noteForDb) {
      await dbService.upsertExternalNote(noteForDb);
    }
  }, [notebooks]);

  const {
    contacts: collaborationContacts,
    status: collaborationStatus,
    sessionNotebookId,
    sessionTopic,
    error: collaborationError,
    addContact,
    removeContact,
    startCollaboration,
    stopCollaboration,
    broadcastLocalUpdate,
  } = useNotebookCollaboration({
    client: xmtpClient,
    onRemoteUpdate: handleRemoteCrdtUpdate,
  });

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

      setNotes(prevNotes => [newNote, ...prevNotes].sort((a, b) => b.updatedAt - a.updatedAt));
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
        await broadcastLocalUpdate(updatedNote);
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

  const handleXmtpConnectAttempt = async () => {
    console.log("App: Attempting XMTP Connect...");
    setIsXmtpConnecting(true);
    setXmtpStatus('connecting');
  };

  const handleXmtpConnected = (client: BrowserClient, address: string, env: 'dev' | 'production') => {
    console.log("App: XMTP Connected", { address, env });
    setXmtpClient(client);
    setUserAddress(address);
    setXmtpStatus('connected');
    setXmtpNetworkEnv(env);
    setIsXmtpConnecting(false);
  };

  const handleXmtpDisconnect = () => {
    console.log("App: XMTP Disconnected");
    setXmtpClient(null);
    setUserAddress(null);
    setXmtpStatus('disconnected');
    setIsXmtpConnecting(false);
    stopCollaboration();
  };

  const handleXmtpError = (errorMessage: string) => {
    console.error("App: XMTP Error", errorMessage);
    setXmtpClient(null);
    setUserAddress(null);
    setXmtpStatus('error');
    setIsXmtpConnecting(false);
  };

  const handleXmtpToggleNetwork = async () => {
    if (isXmtpConnecting) return;
    console.log("App: Toggling XMTP Network...");
    const newEnv = xmtpNetworkEnv === 'dev' ? 'production' : 'dev';
    handleXmtpDisconnect();
    setXmtpNetworkEnv(newEnv);
    setTimeout(() => handleXmtpConnectAttempt(), 100);
  };

  // --- Notebook Deletion --- 
  const handleDeleteNotebook = async (notebookId: string | null) => {
    if (!notebookId) return;

    const notebookToDelete = notebooks.find(nb => nb.id === notebookId);
    if (!notebookToDelete) return;

    // Confirmation
    if (!window.confirm(`Are you sure you want to permanently delete the notebook "${notebookToDelete.name}" and all its contents? This cannot be undone.`)) {
      return;
    }

    try {
      const success = await dbService.deleteNotebook(notebookId);
      if (success) {
        showToast('Success', `Notebook "${notebookToDelete.name}" deleted.`);
        const remainingNotebooks = notebooks.filter(nb => nb.id !== notebookId);
        setNotebooks(remainingNotebooks);

        // Select the first remaining notebook or null if none left
        const newSelectedId = remainingNotebooks[0]?.id || null;
        setSelectedNotebookId(newSelectedId);
        if (!newSelectedId) {
          // Clear notes/folders if no notebook is selected
          setNotes([]);
          setFolders([]);
          setOpenNoteIds([]);
          setActiveNoteId(null);
        }

        // Close the info modal if it was open for the deleted notebook
        // (Need to pass setInfoModalNotebook down or handle state differently)
        // For now, assumes modal is managed within Sidebar

      } else {
        showToast('Error', 'Failed to delete notebook. Notebook not found.', 'destructive');
      }
    } catch (error) {
      console.error("Failed to delete notebook:", error);
      showToast('Error', `Failed to delete notebook: ${error instanceof Error ? error.message : 'Unknown error'}`, 'destructive');
    }
  };

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prevTheme => (prevTheme === 'light' ? 'dark' : 'light'));
  };

  // --- Import Logic --- 
  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      // Basic validation
      if (!file.name.toLowerCase().endsWith('.json.encrypted') && !file.name.toLowerCase().endsWith('.json')) {
        showToast('Error', 'Invalid file type. Please select a .json.encrypted file.', 'destructive');
        event.target.value = '';
        return;
      }
      if (file.size > 50 * 1024 * 1024) { // 50MB limit
        showToast('Error', 'File too large (max 50MB)', 'destructive');
        event.target.value = '';
        return;
      }
      setImportFile(file);
      setShowPasswordModal(true);
    }
    event.target.value = '';
  };

  const handleImportWithPassword = async (password: string) => {
    if (!importFile) return;
    setShowPasswordModal(false);
    setIsImporting(true);
    showToast('Importing', `Processing ${importFile.name}...`);

    try {
      const fileContent = await importFile.text(); // Read as text first
      const wrapperJson = JSON.parse(fileContent);
      const decryptedData: ExportedData = await decryptBackup(password, wrapperJson);

      // --- Data Validation (Basic) --- 
      if (!decryptedData || typeof decryptedData !== 'object' ||
        !decryptedData.notebook || typeof decryptedData.notebook.name !== 'string' ||
        !Array.isArray(decryptedData.folders) || !Array.isArray(decryptedData.notes)) {
        throw new Error("Invalid file structure after decryption.");
      }

      // --- Database Import --- 
      // 1. Create the new notebook (key is derived, not stored)
      const newNotebook = await dbService.createNotebook({
        name: decryptedData.notebook.name || `Imported Notebook (${new Date().toLocaleTimeString()})`
      });

      // 2. Recreate folder structure
      const createdFolderMap = new Map<string | null, string>(); // Map oldPath -> newFolderId
      createdFolderMap.set(null, 'root'); // Represent root

      // Sort folders to process parents before children (simple path depth sort)
      const sortedFolders = [...decryptedData.folders].sort((a, b) =>
        (a.parentPath?.split('/').length ?? 0) - (b.parentPath?.split('/').length ?? 0)
      );

      for (const exportedFolder of sortedFolders) {
        const parentFolderId = createdFolderMap.get(exportedFolder.parentPath) ?? null;
        if (parentFolderId === 'root') { // Root folder
          const newFolder = await dbService.createFolder({
            notebookId: newNotebook.id,
            name: exportedFolder.name,
            parentFolderId: null
          });
          createdFolderMap.set(exportedFolder.name, newFolder.id); // Map path to new ID
        } else if (parentFolderId) { // Nested folder
          const newFolder = await dbService.createFolder({
            notebookId: newNotebook.id,
            name: exportedFolder.name,
            parentFolderId: parentFolderId
          });
          const currentPath = `${exportedFolder.parentPath}/${exportedFolder.name}`;
          createdFolderMap.set(currentPath, newFolder.id);
        } else {
          console.warn(`Could not find parent folder ID for path: ${exportedFolder.parentPath}. Skipping folder: ${exportedFolder.name}`);
        }
      }

      // 3. Create notes
      for (const exportedNote of decryptedData.notes) {
        const folderId = createdFolderMap.get(exportedNote.folderPath) ?? null;
        const targetFolderId = folderId === 'root' ? null : folderId;
        await dbService.createNote({
          notebookId: newNotebook.id,
          folderId: targetFolderId,
          title: exportedNote.title,
          content: exportedNote.content,
          // Consider using original timestamps or resetting them
          // createdAt: exportedNote.createdAt, 
          // updatedAt: exportedNote.updatedAt,
        });
      }

      setNotebooks(nbs => [newNotebook, ...nbs]); // Add to UI list
      setSelectedNotebookId(newNotebook.id); // Select the newly imported notebook
      showToast('Success', `Notebook '${newNotebook.name}' imported successfully.`);

    } catch (error) {
      console.error("Import failed:", error);
      showToast('Import Failed', error instanceof Error ? error.message : 'Unknown error', 'destructive');
    } finally {
      setImportFile(null);
      setIsImporting(false);
    }
  };

  const handleCancelImport = () => {
    setImportFile(null);
    setShowPasswordModal(false);
  };

  if (isDbBlocked) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-75 dark:bg-opacity-90 flex items-center justify-center z-50">
        <div className="bg-white dark:bg-gray-800 p-8 rounded-lg shadow-xl text-center">
          <h2 className="text-xl font-bold mb-4">Database Update Required</h2>
          <p className="mb-6 text-gray-700 dark:text-gray-300">
            storm.dance needs to update its database schema, but another tab might be blocking it.
            Please close any other open tabs running this application.
          </p>
          <p className="mb-6 text-gray-700 dark:text-gray-300">
            If the issue persists, you can clear the local storage. <strong className="text-red-600">This will delete all your current notes.</strong>
          </p>
          <button
            onClick={handleClearStorage}
            className="px-6 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
          >
            Clear Storage & Reload
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen bg-transparent text-gray-900 dark:text-gray-100 font-sans antialiased px-3 pb-4 lg:px-6">
      <TopBar
        theme={theme}
        toggleTheme={toggleTheme}
        xmtpStatus={xmtpStatus}
        xmtpAddress={userAddress}
        xmtpNetworkEnv={xmtpNetworkEnv}
        onXmtpConnect={handleXmtpConnectAttempt}
        onXmtpDisconnect={handleXmtpDisconnect}
        onXmtpToggleNetwork={handleXmtpToggleNetwork}
        onFileChange={handleFileChange}
        isImporting={isImporting}
      />

      <main className="flex-1 overflow-hidden pt-2">
        <div className="flex h-full flex-col gap-3 lg:flex-row lg:gap-4">
          <div
            className="w-full lg:w-1/3 xl:w-1/4 min-h-[38vh] lg:min-h-0 lg:max-w-[360px] border border-gray-200/70 dark:border-gray-800/70 flex flex-col bg-white/80 dark:bg-gray-950/70 rounded-2xl backdrop-blur mobile-card"
            onFocusCapture={() => setActiveColumn('notebooks')}
          >
            <Sidebar
              ref={sidebarRef}
              xmtpClient={xmtpClient}
              onXmtpConnected={handleXmtpConnected}
              onXmtpDisconnected={handleXmtpDisconnect}
              onXmtpError={handleXmtpError}
              initialXmtpNetworkEnv={xmtpNetworkEnv}
              triggerXmtpConnect={isXmtpConnecting && xmtpStatus === 'connecting'}
              triggerXmtpDisconnect={xmtpStatus === 'disconnected'}
              notebooks={notebooks}
              selectedNotebookId={selectedNotebookId}
              notes={notes}
              folders={folders}
              selectedNoteId={activeNoteId}
              onSelectNotebook={setSelectedNotebookId}
              onSelectNote={handleSelectNote}
              onCreateNote={handleCreateNote}
              onDeleteNote={handleDeleteNote}
              onCreateFolder={handleCreateFolder}
              onDeleteFolder={handleDeleteFolder}
              onUpdateFolder={handleUpdateFolder}
              onDeleteNotebook={handleDeleteNotebook}
              onMoveNoteToFolder={handleMoveNoteToFolder}
              onMoveFolder={handleMoveFolder}
              isLoading={isLoading}
              containerRef={notesColumnRef}
              editorTitleInputRef={editorTitleInputRef}
              collaborationContacts={collaborationContacts}
              collaborationStatus={collaborationStatus}
              collaborationTopic={sessionTopic}
              collaborationError={collaborationError || undefined}
              xmtpEnv={xmtpNetworkEnv}
              isXmtpConnected={xmtpStatus === 'connected'}
              onAddCollaborator={addContact}
              onRemoveCollaborator={removeContact}
              onStartCollaborating={(notebookId) => startCollaboration(notebookId || '')}
              onStopCollaborating={stopCollaboration}
            />
          </div>

          <div
            className="flex-1 min-h-[50vh] lg:min-h-0 flex flex-col"
            ref={editorRef}
            tabIndex={0}
            onFocus={() => setActiveColumn('editor')}
          >
            {isLoading ? (
              <div className="flex items-center justify-center h-full rounded-2xl border border-gray-200/70 dark:border-gray-800/70 bg-white/80 dark:bg-gray-900/80 mobile-card text-muted-foreground">
                Loading...
              </div>
            ) : openNoteIds.length > 0 ? (
              <div className="flex h-full flex-col rounded-2xl border border-gray-200/70 dark:border-gray-800/70 bg-white/80 dark:bg-gray-900/80 shadow-lg shadow-gray-900/5 dark:shadow-black/20 backdrop-blur mobile-card">
                <EditorTabs
                  notes={notes}
                  openNoteIds={openNoteIds}
                  activeNoteId={activeNoteId}
                  onSelectTab={setActiveNoteId}
                  onCloseTab={handleCloseTab}
                />
                <div className="flex-1 overflow-auto scrollbar-thin scrollbar-thumb-gray-300 hover:scrollbar-thumb-gray-400 dark:scrollbar-thumb-gray-600 dark:hover:scrollbar-thumb-gray-500 p-4 lg:p-6">
                  <Editor
                    note={activeNote}
                    onUpdateNote={handleUpdateNote}
                    titleInputRef={editorTitleInputRef}
                    textAreaRef={editorTextAreaRef}
                  />
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full rounded-2xl border border-gray-200/70 dark:border-gray-800/70 bg-white/80 dark:bg-gray-900/80 text-gray-500 dark:text-gray-400 mobile-card">
                <p className="italic">Select a note to open it.</p>
              </div>
            )}
          </div>
        </div>
      </main>

      {showPasswordModal && importFile && (
        <ImportPasswordModal
          fileName={importFile.name}
          onImport={handleImportWithPassword}
          onCancel={handleCancelImport}
        />
      )}

      {toastMessage && (
        <div className={`fixed bottom-4 right-4 p-4 rounded-md shadow-lg text-white ${toastMessage.variant === 'destructive'
            ? 'bg-red-600 dark:bg-red-700'
            : 'bg-green-600 dark:bg-green-700'
          }`}>
          <h3 className="font-bold">{toastMessage.title}</h3>
          <p>{toastMessage.description}</p>
        </div>
      )}
    </div>
  );
}

export default App;
