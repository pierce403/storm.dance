import { useState, useEffect, useRef, useCallback } from 'react';
import { Sidebar, SidebarHandle } from './components/notes/Sidebar';
import { Editor } from './components/notes/Editor';
import { EditorTabs } from './components/notes/EditorTabs';
import { Note, Notebook, Folder, dbService, DB_NAME } from './lib/db';
import { createBrowserClient, type BrowserClient } from '@/lib/xmtp-browser-sdk';
import { Key, AlertCircle } from 'lucide-react';
import './App.css';
import './DarkTheme.css';
import { decryptBackup } from './lib/cryptoUtils';
import { TopBar } from './components/TopBar';
import { useNotebookCollaboration } from './hooks/useNotebookCollaboration';
import { rebaseStringEdit, type NotebookCrdtProjection } from './lib/collaboration/crdt';
import { normalizeConversationId } from './lib/collaboration/bindings';
import { CollaborationInviteModal } from './components/collaboration/CollaborationInviteModal';
import { IdentityUtils } from './utils/identity';
import {
  decodeNativeCrdtUpdate,
  listenForNativeCrdtUpdates,
} from './lib/nativeBridge';

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

type ProgrammaticNoteUpdates = Partial<Pick<Note, 'title' | 'content' | 'folderId'>>;
type NoteTextBase = Partial<Pick<Note, 'title' | 'content'>>;

interface StormdanceWorkspaceState {
  selectedNotebookId: string | null;
  selectedNotebookName: string | null;
  activeNoteId: string | null;
  openNoteIds: string[];
  notebookCount: number;
  noteCount: number;
  folderCount: number;
}

interface StormdanceProgrammaticApi {
  getWorkspaceState: () => StormdanceWorkspaceState;
  getNotes: () => Note[];
  getNote: (noteId: string) => Note | null;
  openNote: (noteId: string) => Note | null;
  updateNote: (noteId: string, updates: ProgrammaticNoteUpdates) => Promise<Note | undefined>;
  setNoteTitle: (noteId: string, title: string) => Promise<Note | undefined>;
  setNoteContent: (noteId: string, content: string) => Promise<Note | undefined>;
  createNote: (input?: ProgrammaticNoteUpdates) => Promise<Note | null>;
}

declare global {
  interface Window {
    stormdance?: StormdanceProgrammaticApi;
  }
}

const WORKSPACE_STORAGE_KEYS = {
  selectedNotebookId: 'stormdance.workspace.selectedNotebookId',
  openNoteIds: 'stormdance.workspace.openNoteIds',
  activeNoteId: 'stormdance.workspace.activeNoteId',
} as const;

const readStoredString = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const readStoredStringArray = (key: string): string[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
};

const storeNullableString = (key: string, value: string | null) => {
  if (value) {
    localStorage.setItem(key, value);
  } else {
    localStorage.removeItem(key);
  }
};

const getNotebookConversationId = (
  notebook: Notebook | null | undefined,
  env: 'dev' | 'production',
) => normalizeConversationId(notebook?.xmtpBindings?.[env])
  ?? normalizeConversationId(notebook?.xmtpEnv === env ? notebook?.xmtpTopic : undefined);

const collaborationNoteKey = (notebookId: string, noteId: string) => `${notebookId}\u0000${noteId}`;
const collaborationFolderKey = (notebookId: string, folderId: string) => `${notebookId}\u0000${folderId}`;

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
  const [selectedNotebookId, setSelectedNotebookId] = useState<string | null>(() => readStoredString(WORKSPACE_STORAGE_KEYS.selectedNotebookId));
  const [notes, setNotes] = useState<Note[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [openNoteIds, setOpenNoteIds] = useState<string[]>(() => readStoredStringArray(WORKSPACE_STORAGE_KEYS.openNoteIds));
  const [activeNoteId, setActiveNoteId] = useState<string | null>(() => readStoredString(WORKSPACE_STORAGE_KEYS.activeNoteId));
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
  const [hasIdentity, setHasIdentity] = useState(false);
  const [activeConversationsCount, setActiveConversationsCount] = useState(0);
  const [debugLoggingEnabled, setDebugLoggingEnabled] = useState(false);

  useEffect(() => {
    setHasIdentity(IdentityUtils.hasIdentity());
  }, []);

  const notesColumnRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const editorTitleInputRef = useRef<HTMLInputElement>(null);
  const editorTextAreaRef = useRef<HTMLTextAreaElement>(null);
  const sidebarRef = useRef<SidebarHandle>(null);
  const notebooksListRef = useRef<HTMLUListElement>(null);
  const notesMutationVersionRef = useRef(0);
  const foldersMutationVersionRef = useRef(0);
  const selectedNotebookIdRef = useRef(selectedNotebookId);
  const openNoteIdsRef = useRef(openNoteIds);
  const activeNoteIdRef = useRef(activeNoteId);
  const notebooksRef = useRef(notebooks);
  const notesRef = useRef(notes);
  const foldersRef = useRef(folders);
  const noteUpdateQueuesRef = useRef<Map<string, Promise<Note | undefined>>>(new Map());
  const folderUpdateQueuesRef = useRef<Map<string, Promise<Folder | undefined>>>(new Map());
  const localNoteRevisionsRef = useRef<Map<string, number>>(new Map());
  const localFolderRevisionsRef = useRef<Map<string, number>>(new Map());
  const tombstonedNoteIdsRef = useRef<Set<string>>(new Set());
  const tombstonedFolderIdsRef = useRef<Set<string>>(new Set());
  const autoResumeKeyRef = useRef<string | null>(null);
  const xmtpClientRef = useRef<BrowserClient | null>(null);
  const isXmtpConnectingRef = useRef(false);
  const xmtpConnectionGenerationRef = useRef(0);

  const setSelectedNotebookIdAndStore = useCallback((nextNotebookId: string | null) => {
    selectedNotebookIdRef.current = nextNotebookId;
    setSelectedNotebookId(nextNotebookId);
    storeNullableString(WORKSPACE_STORAGE_KEYS.selectedNotebookId, nextNotebookId);
  }, []);

  const setOpenNoteIdsAndStore = useCallback((nextOpenNoteIds: string[]) => {
    const uniqueOpenNoteIds = [...new Set(nextOpenNoteIds)];
    openNoteIdsRef.current = uniqueOpenNoteIds;
    setOpenNoteIds(uniqueOpenNoteIds);
    localStorage.setItem(WORKSPACE_STORAGE_KEYS.openNoteIds, JSON.stringify(uniqueOpenNoteIds));
  }, []);

  const setActiveNoteIdAndStore = useCallback((nextActiveNoteId: string | null) => {
    activeNoteIdRef.current = nextActiveNoteId;
    setActiveNoteId(nextActiveNoteId);
    storeNullableString(WORKSPACE_STORAGE_KEYS.activeNoteId, nextActiveNoteId);
  }, []);

  const handleCreateIdentity = () => {
    console.log("Creating new XMTP identity...");
    const wallet = IdentityUtils.createRandomIdentity();
    IdentityUtils.saveIdentity(wallet.privateKey);
    setHasIdentity(true);
    handleXmtpConnectAttempt();
  };

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

  const handleCollaborativeNotebookUpdated = useCallback((notebook: Notebook) => {
    const wasAlreadyLocal = notebooksRef.current.some((candidate) => candidate.id === notebook.id);
    setNotebooks((previous) => {
      const exists = previous.some((candidate) => candidate.id === notebook.id);
      const next = exists
        ? previous.map((candidate) => candidate.id === notebook.id ? notebook : candidate)
        : [notebook, ...previous];
      notebooksRef.current = next;
      return next;
    });
    if (!wasAlreadyLocal) setSelectedNotebookIdAndStore(notebook.id);
  }, [setSelectedNotebookIdAndStore]);

  const handleRemoteProjection = useCallback(async (projection: NotebookCrdtProjection) => {
    const notebookId = projection.notebook.id;
    if (!notebooksRef.current.some((notebook) => notebook.id === notebookId)) return;
    const projectedFolders = projection.folders ?? [];
    const localFolderIdsAtProjectionStart = new Set(
      foldersRef.current
        .filter((folder) => folder.notebookId === notebookId)
        .map((folder) => folder.id),
    );
    const projectedFolderIds = new Set(projectedFolders.map((folder) => folder.id));
    const localNoteIdsAtProjectionStart = new Set(
      notesRef.current
        .filter((note) => note.notebookId === notebookId)
        .map((note) => note.id),
    );
    const projectedNoteIds = new Set(projection.notes.map((note) => note.id));
    const commitSelectedNotebookFolders = (nextFolders: Folder[]) => {
      if (selectedNotebookIdRef.current !== notebookId) return;
      const sorted = [...nextFolders].sort((left, right) => left.name.localeCompare(right.name));
      foldersRef.current = sorted;
      setFolders(sorted);
    };
    const commitSelectedNotebookNotes = (nextNotes: Note[]) => {
      if (selectedNotebookIdRef.current !== notebookId) return;
      const sorted = [...nextNotes].sort((left, right) => right.updatedAt - left.updatedAt);
      notesRef.current = sorted;
      setNotes(sorted);
      const validOpen = openNoteIdsRef.current.filter((id) => sorted.some((note) => note.id === id));
      if (validOpen.length !== openNoteIdsRef.current.length) setOpenNoteIdsAndStore(validOpen);
      if (activeNoteIdRef.current && !validOpen.includes(activeNoteIdRef.current)) {
        setActiveNoteIdAndStore(validOpen[0] || null);
      }
    };
    const projectedLocalFolderRevisions = new Map(
      projectedFolders.map((folder) => {
        const key = collaborationFolderKey(notebookId, folder.id);
        if (folder.deleted) tombstonedFolderIdsRef.current.add(key);
        else tombstonedFolderIdsRef.current.delete(key);
        return [folder.id, localFolderRevisionsRef.current.get(key) ?? 0] as const;
      }),
    );
    const projectedLocalRevisions = new Map(
      projection.notes.map((note) => {
        const key = collaborationNoteKey(notebookId, note.id);
        if (note.deleted) tombstonedNoteIdsRef.current.add(key);
        else tombstonedNoteIdsRef.current.delete(key);
        return [note.id, localNoteRevisionsRef.current.get(key) ?? 0] as const;
      }),
    );
    // Project into the controlled editor before any IndexedDB await. This
    // keeps the editor's next full-value change based on the current Yjs text.
    // Folders are committed first so a note never flashes at the root merely
    // because its folder row is still awaiting IndexedDB persistence.
    commitSelectedNotebookFolders(projectedFolders
      .filter((folder) => !folder.deleted)
      .map((folder) => ({
        id: folder.id,
        notebookId,
        name: folder.name,
        parentFolderId: folder.parentFolderId,
        createdAt: folder.createdAt,
        updatedAt: folder.updatedAt,
      })));
    commitSelectedNotebookNotes(projection.notes
      .filter((note) => !note.deleted)
      .map((note) => ({
        id: note.id,
        notebookId,
        folderId: note.folderId,
        title: note.title,
        content: note.content,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      })));
    const existingNotebook = await dbService.getNotebook(notebookId);
    if (!existingNotebook) return;

    const projectedNotebook: Notebook = {
      ...existingNotebook,
      name: projection.notebook.name,
      createdAt: projection.notebook.createdAt,
      updatedAt: projection.notebook.updatedAt,
    };
    await dbService.createReplicaNotebook(projectedNotebook);
    handleCollaborativeNotebookUpdated(projectedNotebook);

    const materializedFolders = new Map<string, Folder>();
    for (const projected of projectedFolders) {
      const key = collaborationFolderKey(notebookId, projected.id);
      const projectedLocalRevision = projectedLocalFolderRevisions.get(projected.id) ?? 0;
      const previousUpdate = folderUpdateQueuesRef.current.get(key) || Promise.resolve(undefined);
      const queuedUpdate = previousUpdate
        .catch(() => undefined)
        .then(async (): Promise<Folder | undefined> => {
          if (projected.deleted) {
            await dbService.deleteExternalFolder(projected.id, notebookId);
            return undefined;
          }
          if ((localFolderRevisionsRef.current.get(key) ?? 0) !== projectedLocalRevision) {
            return foldersRef.current.find((folder) => (
              folder.id === projected.id && folder.notebookId === notebookId
            ));
          }
          const folder: Folder = {
            id: projected.id,
            notebookId,
            name: projected.name,
            parentFolderId: projected.parentFolderId,
            createdAt: projected.createdAt,
            updatedAt: projected.updatedAt,
          };
          await dbService.upsertExternalFolder(folder);
          return folder;
        });
      folderUpdateQueuesRef.current.set(key, queuedUpdate);
      const materialized = await queuedUpdate;
      if (materialized) materializedFolders.set(projected.id, materialized);
      if (folderUpdateQueuesRef.current.get(key) === queuedUpdate) {
        folderUpdateQueuesRef.current.delete(key);
      }
    }

    foldersMutationVersionRef.current += 1;
    const currentFolders = foldersRef.current;
    const projectedFoldersAfterPersistence = projectedFolders
      .filter((projected) => !projected.deleted)
      .map((projected) => {
        const key = collaborationFolderKey(notebookId, projected.id);
        const revisionChanged = (localFolderRevisionsRef.current.get(key) ?? 0)
          !== (projectedLocalFolderRevisions.get(projected.id) ?? 0);
        return revisionChanged
          ? currentFolders.find((folder) => folder.id === projected.id && folder.notebookId === notebookId)
          : materializedFolders.get(projected.id);
      })
      .filter((folder): folder is Folder => folder !== undefined);
    const locallyCreatedFoldersDuringProjection = currentFolders.filter((folder) => {
      if (folder.notebookId !== notebookId || projectedFolderIds.has(folder.id)) return false;
      const key = collaborationFolderKey(notebookId, folder.id);
      return !localFolderIdsAtProjectionStart.has(folder.id)
        && (localFolderRevisionsRef.current.get(key) ?? 0) > 0
        && !tombstonedFolderIdsRef.current.has(key);
    });
    commitSelectedNotebookFolders([
      ...projectedFoldersAfterPersistence,
      ...locallyCreatedFoldersDuringProjection,
    ]);

    const materializedNotes = new Map<string, Note>();
    for (const projected of projection.notes) {
      const key = collaborationNoteKey(notebookId, projected.id);
      const projectedLocalRevision = projectedLocalRevisions.get(projected.id) ?? 0;
      const previousUpdate = noteUpdateQueuesRef.current.get(key) || Promise.resolve(undefined);
      const queuedUpdate = previousUpdate
        .catch(() => undefined)
        .then(async (): Promise<Note | undefined> => {
          if (projected.deleted) {
            await dbService.deleteNote(projected.id, notebookId);
            return undefined;
          }
          if ((localNoteRevisionsRef.current.get(key) ?? 0) !== projectedLocalRevision) {
            return notesRef.current.find((note) => (
              note.id === projected.id && note.notebookId === notebookId
            ));
          }
          const note: Note = {
            id: projected.id,
            notebookId,
            folderId: projected.folderId,
            title: projected.title,
            content: projected.content,
            createdAt: projected.createdAt,
            updatedAt: projected.updatedAt,
          };
          await dbService.upsertExternalNote(note);
          return note;
        });
      noteUpdateQueuesRef.current.set(key, queuedUpdate);
      const materialized = await queuedUpdate;
      if (materialized) materializedNotes.set(projected.id, materialized);
      if (noteUpdateQueuesRef.current.get(key) === queuedUpdate) {
        noteUpdateQueuesRef.current.delete(key);
      }
    }

    notesMutationVersionRef.current += 1;
    const currentNotes = notesRef.current;
    const projectedNotesAfterPersistence = projection.notes
      .filter((projected) => !projected.deleted)
      .map((projected) => {
        const key = collaborationNoteKey(notebookId, projected.id);
        const revisionChanged = (localNoteRevisionsRef.current.get(key) ?? 0)
          !== (projectedLocalRevisions.get(projected.id) ?? 0);
        return revisionChanged
          ? currentNotes.find((note) => note.id === projected.id && note.notebookId === notebookId)
          : materializedNotes.get(projected.id);
      })
      .filter((note): note is Note => note !== undefined);
    const locallyCreatedDuringProjection = currentNotes.filter((note) => {
      if (note.notebookId !== notebookId || projectedNoteIds.has(note.id)) return false;
      const key = collaborationNoteKey(notebookId, note.id);
      return !localNoteIdsAtProjectionStart.has(note.id)
        && (localNoteRevisionsRef.current.get(key) ?? 0) > 0
        && !tombstonedNoteIdsRef.current.has(key);
    });
    commitSelectedNotebookNotes([
      ...projectedNotesAfterPersistence,
      ...locallyCreatedDuringProjection,
    ]);
  }, [handleCollaborativeNotebookUpdated, setActiveNoteIdAndStore, setOpenNoteIdsAndStore]);

  const {
    contacts: collaborationContacts,
    contactsNotebookId: collaborationContactsNotebookId,
    collaborators: notebookCollaborators,
    collaboratorsPending,
    status: collaborationStatus,
    sessionNotebookId,
    sessionTopic,
    error: collaborationError,
    collaboratorsError,
    addContact,
    removeContact,
    refreshCollaborators,
    addNotebookCollaborator,
    changeNotebookCollaboratorRole,
    removeNotebookCollaborator,
    startCollaboration,
    resumeCollaboration,
    stopCollaboration,
    broadcastLocalUpdate,
    broadcastLocalDelete,
    broadcastLocalFolderUpdate,
    broadcastLocalFolderDelete,
    broadcastNotebookRename,
    applyNativeUpdate,
    inviteModalOpen,
    inviteDetails,
    acceptInvite,
    rejectInvite,
  } = useNotebookCollaboration({
    client: xmtpClient,
    userAddress: userAddress,
    xmtpEnv: xmtpNetworkEnv,
    onRemoteProjection: handleRemoteProjection,
    onNotebookUpdated: handleCollaborativeNotebookUpdated,
    debugLoggingEnabled: debugLoggingEnabled,
  });

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void listenForNativeCrdtUpdates((nativeUpdate) => {
      if (!active) return;
      try {
        const update = decodeNativeCrdtUpdate(nativeUpdate.updateBase64);
        void applyNativeUpdate(nativeUpdate, update).catch((error) => {
          console.warn('Could not apply a native Markdown vault update', error);
        });
      } catch (error) {
        console.warn('Rejected an invalid native Markdown vault update', error);
      }
    }).then((stopListening) => {
      if (active) unsubscribe = stopListening;
      else stopListening();
    }).catch((error) => {
      if (debugLoggingEnabled) console.warn('Could not subscribe to native vault updates', error);
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [applyNativeUpdate, debugLoggingEnabled]);

  const getNoteById = (id: string | null): Note | null => {
    if (!id) return null;
    return notes.find(note => note.id === id) || null;
  }
  const selectedNotebook = notebooks.find(notebook => notebook.id === selectedNotebookId) || null;
  const selectedNotebookConversationId = getNotebookConversationId(selectedNotebook, xmtpNetworkEnv);
  const activeNote = getNoteById(activeNoteId);

  useEffect(() => {
    if (!xmtpClient) {
      autoResumeKeyRef.current = null;
      return;
    }

    const notebookId = selectedNotebook?.id;
    const conversationId = selectedNotebookConversationId;
    if (!notebookId || !conversationId) {
      autoResumeKeyRef.current = null;
      if (sessionNotebookId) void stopCollaboration();
      return;
    }

    const resumeKey = `${xmtpNetworkEnv}:${notebookId}:${conversationId}`;
    if (sessionNotebookId === notebookId) {
      autoResumeKeyRef.current = resumeKey;
      return;
    }
    if (collaborationStatus === 'starting') return;
    if (autoResumeKeyRef.current === resumeKey) return;
    autoResumeKeyRef.current = resumeKey;
    void resumeCollaboration(notebookId, selectedNotebook.name);
  }, [
    collaborationStatus,
    resumeCollaboration,
    selectedNotebook?.id,
    selectedNotebook?.name,
    selectedNotebookConversationId,
    sessionNotebookId,
    stopCollaboration,
    xmtpClient,
    xmtpNetworkEnv,
  ]);

  const workspaceStatus = isLoading
    ? 'Stormdance workspace loading.'
    : [
      'Stormdance workspace ready.',
      selectedNotebook ? `Selected notebook: ${selectedNotebook.name}.` : 'No notebook selected.',
      activeNote ? `Selected note: ${activeNote.title || 'Untitled'}.` : 'No note selected.',
      `${notes.length} notes and ${folders.length} folders in the selected notebook.`,
      `${openNoteIds.length} editor tabs open.`,
      `Editor column: ${activeNote ? 'editing a note' : 'empty'}.`,
      `XMTP status: ${xmtpStatus} on ${xmtpNetworkEnv}.`,
      `Collaboration status: ${collaborationStatus}.`,
    ].join(' ');

  const showToast = useCallback((title: string, description: string, variant: 'default' | 'destructive' = 'default') => {
    setToastMessage({ title, description, variant });
    setTimeout(() => setToastMessage(null), 3000);
  }, []);

  useEffect(() => {
    notebooksRef.current = notebooks;
  }, [notebooks]);

  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  useEffect(() => {
    foldersRef.current = folders;
  }, [folders]);

  useEffect(() => {
    selectedNotebookIdRef.current = selectedNotebookId;
    storeNullableString(WORKSPACE_STORAGE_KEYS.selectedNotebookId, selectedNotebookId);
  }, [selectedNotebookId]);

  useEffect(() => {
    openNoteIdsRef.current = openNoteIds;
    localStorage.setItem(WORKSPACE_STORAGE_KEYS.openNoteIds, JSON.stringify(openNoteIds));
  }, [openNoteIds]);

  useEffect(() => {
    activeNoteIdRef.current = activeNoteId;
    storeNullableString(WORKSPACE_STORAGE_KEYS.activeNoteId, activeNoteId);
  }, [activeNoteId]);

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
      notesMutationVersionRef.current += 1;
      const key = collaborationNoteKey(newNote.notebookId, newNote.id);
      localNoteRevisionsRef.current.set(key, (localNoteRevisionsRef.current.get(key) ?? 0) + 1);
      tombstonedNoteIdsRef.current.delete(key);
      const nextNotes = [newNote, ...notesRef.current.filter((note) => note.id !== newNote.id)]
        .sort((left, right) => right.updatedAt - left.updatedAt);
      notesRef.current = nextNotes;
      setNotes(nextNotes);
      setOpenNoteIdsAndStore([...openNoteIdsRef.current, newNote.id]);
      setActiveNoteIdAndStore(newNote.id);
      broadcastLocalUpdate(newNote);

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
  }, [broadcastLocalUpdate, selectedNotebookId, setActiveNoteIdAndStore, setOpenNoteIdsAndStore, showToast]);

  useEffect(() => {
    const handleGlobalKeyDown = (e: globalThis.KeyboardEvent) => {
      const isBrowserSafeCommand = (e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey;
      if (isBrowserSafeCommand) {
        const focusColumn = (column: 'notebooks' | 'notes' | 'editor') => {
          e.preventDefault();
          setActiveColumn(column);
          window.setTimeout(() => {
            if (column === 'notebooks') {
              const selectedNotebookSelector = selectedNotebookId ? `[data-notebook-id="${selectedNotebookId}"]` : '[data-notebook-id]';
              document.querySelector<HTMLButtonElement>(selectedNotebookSelector)?.focus();
            } else if (column === 'notes') {
              sidebarRef.current?.focusItem(activeNoteId ? 'note' : null, activeNoteId);
            } else if (column === 'editor') {
              if (activeNote) {
                editorTitleInputRef.current?.focus();
              } else {
                editorRef.current?.focus();
              }
            }
          }, 0);
        };

        if (e.key.toLowerCase() === 'n') {
          e.preventDefault();
          handleCreateNote();
          return;
        }

        if (e.key.toLowerCase() === 's') {
          e.preventDefault();
          showToast(
            activeNote ? 'Saved locally' : 'Workspace ready',
            activeNote ? `"${activeNote.title || 'Untitled'}" is already saved locally.` : 'There is no open note to save.'
          );
          return;
        }

        if (e.key === '[' || e.key === ']') {
          e.preventDefault();
          if (openNoteIds.length === 0) return;
          const direction = e.key === '[' ? -1 : 1;
          const currentIndex = activeNoteId ? openNoteIds.indexOf(activeNoteId) : -1;
          const nextIndex = currentIndex >= 0
            ? (currentIndex + direction + openNoteIds.length) % openNoteIds.length
            : 0;
          setActiveNoteIdAndStore(openNoteIds[nextIndex]);
          return;
        }

        if (e.key === '1') {
          focusColumn('notebooks');
          return;
        }

        if (e.key === '2') {
          focusColumn('notes');
          return;
        }

        if (e.key === '3') {
          focusColumn('editor');
          return;
        }
      }

      if (e.key !== 'Tab') return;

      const target = e.target as HTMLElement | null;
      const isTextEntry = target ?
        ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName) || target.isContentEditable || target.getAttribute('role') === 'textbox'
        : false;

      if (isTextEntry) {
        return; // Preserve native tab order when editing or interacting with controls
      }

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

      if (!nextColumn) return;

      setActiveColumn(nextColumn);
      if (nextColumn === 'notebooks') {
        const targetButton = notebooksListRef.current?.querySelector(
          selectedNotebookId ? `button[data-notebook-id="${selectedNotebookId}"]` : 'button'
        ) as HTMLButtonElement | null;
        targetButton?.focus();
      } else if (nextColumn === 'notes') {
        sidebarRef.current?.focusItem(activeNoteId ? 'note' : 'folder', activeNoteId);
      } else if (nextColumn === 'editor') {
        if (activeNote) {
          if (editorTitleInputRef.current) {
            editorTitleInputRef.current.focus();
          } else {
            editorTextAreaRef.current?.focus();
          }
        } else {
          editorRef.current?.focus();
        }
      }
    };

    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => {
      document.removeEventListener('keydown', handleGlobalKeyDown);
    };
  }, [activeColumn, activeNote, activeNoteId, handleCreateNote, openNoteIds, selectedNotebookId, setActiveNoteIdAndStore, showToast]);

  useEffect(() => {
    const loadInitialData = async () => {
      setIsLoading(true);
      try {
        const defaultNotebook = await dbService._ensureDefaultNotebook();
        const allNotebooks = await dbService.getAllNotebooks();
        setNotebooks(allNotebooks);

        const initialSelectedNotebookId = selectedNotebookIdRef.current;
        if (!initialSelectedNotebookId) {
          setSelectedNotebookIdAndStore(defaultNotebook.id);
        } else {
          const selectedExists = allNotebooks.some(nb => nb.id === initialSelectedNotebookId);
          if (!selectedExists) {
            setSelectedNotebookIdAndStore(defaultNotebook.id);
          }
        }
        setIsDbBlocked(false);

      } catch (error) {
        console.error('Failed initialization:', error);
        setIsDbBlocked(true);
        showToast('Error', 'Failed to initialize database. Another tab might be blocking an update.', 'destructive');
      }
    };
    loadInitialData();
  }, [setSelectedNotebookIdAndStore, showToast]);

  useEffect(() => {
    const loadNotes = async () => {
      if (!selectedNotebookId) {
        setNotes([]);
        setOpenNoteIdsAndStore([]);
        setActiveNoteIdAndStore(null);
        setFolders([]);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      try {
        const loadStartedAtVersion = notesMutationVersionRef.current;
        const folderLoadStartedAtVersion = foldersMutationVersionRef.current;
        let notebookFolders = await dbService.getAllFolders(selectedNotebookId);
        const foldersChangedDuringLoad = folderLoadStartedAtVersion !== foldersMutationVersionRef.current;
        if (foldersChangedDuringLoad) {
          notebookFolders = await dbService.getAllFolders(selectedNotebookId);
        }
        foldersRef.current = notebookFolders;
        setFolders(notebookFolders);

        let notebookNotes = await dbService.getAllNotes(selectedNotebookId);
        const notesChangedDuringLoad = loadStartedAtVersion !== notesMutationVersionRef.current;
        if (notesChangedDuringLoad) {
          notebookNotes = await dbService.getAllNotes(selectedNotebookId);
        }
        setNotes(notebookNotes);

        const validOpenNoteIds = openNoteIdsRef.current.filter(id => notebookNotes.some(n => n.id === id));
        setOpenNoteIdsAndStore(validOpenNoteIds);

        const currentActiveNoteId = activeNoteIdRef.current;
        if (currentActiveNoteId && !validOpenNoteIds.includes(currentActiveNoteId)) {
          setActiveNoteIdAndStore(validOpenNoteIds[0] || null);
        } else if (!currentActiveNoteId && validOpenNoteIds.length > 0) {
          setActiveNoteIdAndStore(validOpenNoteIds[0]);
        }

      } catch (error) {
        console.error('Failed to load notes for notebook:', error);
        showToast('Error', 'Failed to load notes', 'destructive');
        setNotes([]);
        setOpenNoteIdsAndStore([]);
        setActiveNoteIdAndStore(null);
      } finally {
        setIsLoading(false);
      }
    };

    loadNotes();
  }, [selectedNotebookId, setActiveNoteIdAndStore, setOpenNoteIdsAndStore, showToast]);

  const openNoteById = useCallback((noteId: string): Note | null => {
    const note = notesRef.current.find(candidate => candidate.id === noteId) || null;
    if (!note) return null;

    if (!openNoteIdsRef.current.includes(note.id)) {
      setOpenNoteIdsAndStore([...openNoteIdsRef.current, note.id]);
    }
    setActiveNoteIdAndStore(note.id);
    return { ...note };
  }, [setActiveNoteIdAndStore, setOpenNoteIdsAndStore]);

  const handleSelectNote = useCallback((note: Note) => {
    if (!note) return;
    openNoteById(note.id);
  }, [openNoteById]);

  const handleCloseTab = (noteIdToClose: string) => {
    const currentOpenNoteIds = openNoteIdsRef.current;
    const remainingOpenIds = currentOpenNoteIds.filter(id => id !== noteIdToClose);
    setOpenNoteIdsAndStore(remainingOpenIds);
    if (activeNoteIdRef.current === noteIdToClose) {
      const currentIndex = currentOpenNoteIds.indexOf(noteIdToClose);
      const nextActiveId = currentOpenNoteIds[currentIndex - 1] || currentOpenNoteIds[currentIndex + 1] || null;
      setActiveNoteIdAndStore(remainingOpenIds.find(id => id === nextActiveId) || remainingOpenIds[0] || null);
    }
  };

  const handleUpdateNote = useCallback((
    id: string,
    updates: ProgrammaticNoteUpdates,
    textBase: NoteTextBase = {},
  ): Promise<Note | undefined> => {
    const currentNote = notesRef.current.find((note) => note.id === id);
    if (!currentNote) return Promise.resolve(undefined);
    const key = collaborationNoteKey(currentNote.notebookId, id);
    if (tombstonedNoteIdsRef.current.has(key)) return Promise.resolve(undefined);

    const rebasedUpdates: ProgrammaticNoteUpdates = { ...updates };
    if (updates.title !== undefined && textBase.title !== undefined) {
      rebasedUpdates.title = rebaseStringEdit(textBase.title, updates.title, currentNote.title);
    }
    if (updates.content !== undefined && textBase.content !== undefined) {
      rebasedUpdates.content = rebaseStringEdit(textBase.content, updates.content, currentNote.content);
    }
    const optimisticNote: Note = {
      ...currentNote,
      ...rebasedUpdates,
      updatedAt: Math.max(Date.now(), currentNote.updatedAt + 1),
    };
    localNoteRevisionsRef.current.set(key, (localNoteRevisionsRef.current.get(key) ?? 0) + 1);
    const optimisticNotes = notesRef.current.map((note) => note.id === id ? optimisticNote : note);
    notesRef.current = optimisticNotes;
    setNotes(optimisticNotes);

    // Apply the editor delta to Yjs before awaiting IndexedDB. A remote update
    // arriving during storage I/O now merges with the current local text
    // instead of treating a stale whole-editor value as a deletion.
    broadcastLocalUpdate(optimisticNote);

    const previousUpdate = noteUpdateQueuesRef.current.get(key) || Promise.resolve(undefined);

    const queuedUpdate = previousUpdate
      .catch(() => undefined)
      .then(async (): Promise<Note | undefined> => {
        try {
          if (tombstonedNoteIdsRef.current.has(key)) return undefined;
          await dbService.upsertExternalNote(optimisticNote);
          return optimisticNote;
        } catch (error) {
          console.error('Failed to update note:', error);
          showToast('Error', 'Failed to update note', 'destructive');
          return undefined;
        }
      });

    noteUpdateQueuesRef.current.set(key, queuedUpdate);
    queuedUpdate.finally(() => {
      if (noteUpdateQueuesRef.current.get(key) === queuedUpdate) {
        noteUpdateQueuesRef.current.delete(key);
      }
    });

    return queuedUpdate;
  }, [broadcastLocalUpdate, showToast]);

  const createProgrammaticNote = useCallback(async (input: ProgrammaticNoteUpdates = {}): Promise<Note | null> => {
    const newNote = await handleCreateNote(input.folderId ?? null);
    if (!newNote) return null;

    const updates: ProgrammaticNoteUpdates = {};
    if (input.title !== undefined) updates.title = input.title;
    if (input.content !== undefined) updates.content = input.content;

    if (Object.keys(updates).length === 0) {
      return newNote;
    }

    return await handleUpdateNote(newNote.id, updates) || newNote;
  }, [handleCreateNote, handleUpdateNote]);

  useEffect(() => {
    const api: StormdanceProgrammaticApi = {
      getWorkspaceState: () => ({
        selectedNotebookId: selectedNotebookIdRef.current,
        selectedNotebookName: notebooksRef.current.find(notebook => notebook.id === selectedNotebookIdRef.current)?.name || null,
        activeNoteId: activeNoteIdRef.current,
        openNoteIds: [...openNoteIdsRef.current],
        notebookCount: notebooksRef.current.length,
        noteCount: notesRef.current.length,
        folderCount: foldersRef.current.length,
      }),
      getNotes: () => notesRef.current.map(note => ({ ...note })),
      getNote: (noteId: string) => {
        const note = notesRef.current.find(candidate => candidate.id === noteId);
        return note ? { ...note } : null;
      },
      openNote: openNoteById,
      updateNote: handleUpdateNote,
      setNoteTitle: (noteId: string, title: string) => handleUpdateNote(noteId, { title }),
      setNoteContent: (noteId: string, content: string) => handleUpdateNote(noteId, { content }),
      createNote: createProgrammaticNote,
    };

    window.stormdance = api;
    return () => {
      if (window.stormdance === api) {
        delete window.stormdance;
      }
    };
  }, [createProgrammaticNote, handleUpdateNote, openNoteById]);

  const handleDeleteNote = async (id: string) => {
    try {
      const deletedAt = Date.now();
      const noteToDelete = notesRef.current.find((note) => note.id === id);
      if (!noteToDelete) return;
      const key = collaborationNoteKey(noteToDelete.notebookId, id);
      localNoteRevisionsRef.current.set(key, (localNoteRevisionsRef.current.get(key) ?? 0) + 1);
      tombstonedNoteIdsRef.current.add(key);
      notesMutationVersionRef.current += 1;

      const updatedNotes = notesRef.current
        .filter(note => note.id !== id)
        .sort((a, b) => b.updatedAt - a.updatedAt);
      notesRef.current = updatedNotes;
      setNotes(updatedNotes);

      if (openNoteIdsRef.current.includes(id)) {
        handleCloseTab(id);
      }

      const broadcastDelete = broadcastLocalDelete(noteToDelete, deletedAt);
      const previousUpdate = noteUpdateQueuesRef.current.get(key) || Promise.resolve(undefined);
      const queuedDelete = previousUpdate
        .catch(() => undefined)
        .then(async (): Promise<Note | undefined> => {
          await broadcastDelete;
          await dbService.deleteNote(id, noteToDelete.notebookId);
          return undefined;
      });
      noteUpdateQueuesRef.current.set(key, queuedDelete);
      try {
        await queuedDelete;
      } finally {
        if (noteUpdateQueuesRef.current.get(key) === queuedDelete) {
          noteUpdateQueuesRef.current.delete(key);
        }
      }
      notesMutationVersionRef.current += 1;

      showToast('Success', 'Note deleted');
    } catch (error) {
      console.error('Failed to delete note:', error);
      showToast('Error', 'Failed to delete note', 'destructive');
    }
  };

  const applyFolderUpdate = useCallback((
    folderId: string,
    updates: Partial<Omit<Folder, 'id' | 'createdAt' | 'updatedAt' | 'notebookId'>>,
  ): Promise<Folder | undefined> => {
    const currentFolder = foldersRef.current.find((folder) => folder.id === folderId);
    if (!currentFolder) return Promise.resolve(undefined);
    const key = collaborationFolderKey(currentFolder.notebookId, folderId);
    if (tombstonedFolderIdsRef.current.has(key)) return Promise.resolve(undefined);

    const optimisticFolder: Folder = {
      ...currentFolder,
      ...updates,
      updatedAt: Math.max(Date.now(), currentFolder.updatedAt + 1),
    };
    localFolderRevisionsRef.current.set(key, (localFolderRevisionsRef.current.get(key) ?? 0) + 1);
    foldersMutationVersionRef.current += 1;
    const optimisticFolders = foldersRef.current
      .map((folder) => folder.id === folderId ? optimisticFolder : folder)
      .sort((left, right) => left.name.localeCompare(right.name));
    foldersRef.current = optimisticFolders;
    setFolders(optimisticFolders);

    broadcastLocalFolderUpdate(optimisticFolder);
    const previousUpdate = folderUpdateQueuesRef.current.get(key) || Promise.resolve(undefined);
    const queuedUpdate = previousUpdate
      .catch(() => undefined)
      .then(async (): Promise<Folder | undefined> => {
        if (tombstonedFolderIdsRef.current.has(key)) return undefined;
        await dbService.upsertExternalFolder(optimisticFolder);
        return optimisticFolder;
      });
    folderUpdateQueuesRef.current.set(key, queuedUpdate);
    queuedUpdate.finally(() => {
      if (folderUpdateQueuesRef.current.get(key) === queuedUpdate) {
        folderUpdateQueuesRef.current.delete(key);
      }
    });
    return queuedUpdate;
  }, [broadcastLocalFolderUpdate]);

  const handleCreateFolder = async (name: string, parentFolderId: string | null) => {
    const notebookId = selectedNotebookIdRef.current;
    if (!notebookId) {
      showToast('Error', 'Please select a notebook first', 'destructive');
      return;
    }
    try {
      const newFolder = await dbService.createFolder({
        notebookId,
        name,
        parentFolderId,
      });
      const key = collaborationFolderKey(notebookId, newFolder.id);
      localFolderRevisionsRef.current.set(key, (localFolderRevisionsRef.current.get(key) ?? 0) + 1);
      tombstonedFolderIdsRef.current.delete(key);
      foldersMutationVersionRef.current += 1;
      if (selectedNotebookIdRef.current === notebookId) {
        const nextFolders = [
          ...foldersRef.current.filter((folder) => folder.id !== newFolder.id),
          newFolder,
        ].sort((left, right) => left.name.localeCompare(right.name));
        foldersRef.current = nextFolders;
        setFolders(nextFolders);
      }
      broadcastLocalFolderUpdate(newFolder);
      showToast('Success', 'New folder created');
    } catch (error) {
      console.error('Failed to create folder:', error);
      showToast('Error', 'Failed to create folder', 'destructive');
    }
  };

  const handleDeleteFolder = async (folderId: string) => {
    try {
      const folderToDelete = foldersRef.current.find((folder) => folder.id === folderId);
      if (!folderToDelete) return;
      const affectedNotes = notesRef.current.filter((note) => (
        note.notebookId === folderToDelete.notebookId && note.folderId === folderId
      ));
      const affectedFolders = foldersRef.current.filter((folder) => (
        folder.notebookId === folderToDelete.notebookId && folder.parentFolderId === folderId
      ));
      await Promise.all([
        ...affectedNotes.map((note) => (
          handleUpdateNote(note.id, { folderId: folderToDelete.parentFolderId })
        )),
        ...affectedFolders.map((folder) => (
          applyFolderUpdate(folder.id, { parentFolderId: folderToDelete.parentFolderId })
        )),
      ]);

      const deletedAt = Date.now();
      const key = collaborationFolderKey(folderToDelete.notebookId, folderId);
      localFolderRevisionsRef.current.set(key, (localFolderRevisionsRef.current.get(key) ?? 0) + 1);
      tombstonedFolderIdsRef.current.add(key);
      foldersMutationVersionRef.current += 1;
      const nextFolders = foldersRef.current
        .filter(folder => folder.id !== folderId)
        .map((folder) => folder.parentFolderId === folderId
          ? { ...folder, parentFolderId: folderToDelete.parentFolderId }
          : folder);
      foldersRef.current = nextFolders;
      setFolders(nextFolders);

      const broadcastDelete = broadcastLocalFolderDelete(folderToDelete, deletedAt);
      const previousUpdate = folderUpdateQueuesRef.current.get(key) || Promise.resolve(undefined);
      const queuedDelete = previousUpdate
        .catch(() => undefined)
        .then(async (): Promise<Folder | undefined> => {
          await broadcastDelete;
          await dbService.deleteFolder(folderId);
          return undefined;
        });
      folderUpdateQueuesRef.current.set(key, queuedDelete);
      try {
        await queuedDelete;
      } finally {
        if (folderUpdateQueuesRef.current.get(key) === queuedDelete) {
          folderUpdateQueuesRef.current.delete(key);
        }
      }

      showToast('Success', 'Folder deleted');
    } catch (error) {
      console.error('Failed to delete folder:', error);
      showToast('Error', 'Failed to delete folder', 'destructive');
    }
  };

  const handleUpdateFolder = async (folderId: string, updates: Partial<Omit<Folder, 'id' | 'createdAt' | 'updatedAt' | 'notebookId'>>) => {
    try {
      const updatedFolder = await applyFolderUpdate(folderId, updates);

      if (updatedFolder) {
        showToast('Success', 'Folder updated');
      }
    } catch (error) {
      console.error('Failed to update folder:', error);
      showToast('Error', 'Failed to update folder', 'destructive');
    }
  };

  const handleMoveFolder = async (folderId: string, targetParentFolderId: string | null) => {
    try {
      const folder = foldersRef.current.find((candidate) => candidate.id === folderId);
      if (!folder) return;
      if (targetParentFolderId) {
        const target = foldersRef.current.find((candidate) => candidate.id === targetParentFolderId);
        if (!target || target.notebookId !== folder.notebookId) {
          throw new Error('The destination folder is not part of this notebook');
        }
        let currentParentId: string | null = target.id;
        const visited = new Set<string>();
        while (currentParentId) {
          if (currentParentId === folderId) {
            console.warn(`Move of folder ${folderId} to its descendant ${targetParentFolderId} was disallowed.`);
            return;
          }
          if (visited.has(currentParentId)) return;
          visited.add(currentParentId);
          currentParentId = foldersRef.current.find((candidate) => candidate.id === currentParentId)?.parentFolderId ?? null;
        }
      }
      const updatedFolder = await applyFolderUpdate(folderId, { parentFolderId: targetParentFolderId });
      if (updatedFolder) {
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
      const updatedNote = await handleUpdateNote(noteId, { folderId: targetFolderId });
      if (updatedNote) {
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

  const handleXmtpConnectAttempt = async (env: 'dev' | 'production' = xmtpNetworkEnv) => {
    if (isXmtpConnectingRef.current || xmtpClientRef.current) return;

    const generation = ++xmtpConnectionGenerationRef.current;
    console.log(`App: Attempting XMTP connect on ${env}...`);
    isXmtpConnectingRef.current = true;
    setIsXmtpConnecting(true);
    setXmtpStatus('connecting');

    let createdClient: BrowserClient | null = null;
    try {
      const { client, wallet } = await createBrowserClient({ env });
      createdClient = client;
      const address = await wallet.getAddress();
      if (xmtpConnectionGenerationRef.current !== generation) {
        client.close();
        return;
      }
      await handleXmtpConnected(client, address, env);
    } catch (error) {
      createdClient?.close();
      if (xmtpConnectionGenerationRef.current !== generation) return;
      handleXmtpError(error instanceof Error ? error.message : 'XMTP connection failed');
    }
  };

  const handleXmtpConnected = async (client: BrowserClient, address: string, env: 'dev' | 'production') => {
    console.log("App: XMTP Connected", { address, env });
    xmtpClientRef.current = client;
    isXmtpConnectingRef.current = false;
    setXmtpClient(client);
    setUserAddress(address);
    setXmtpStatus('connected');
    setXmtpNetworkEnv(env);
    setIsXmtpConnecting(false);

    try {
      const conversations = await client.conversations.list();
      setActiveConversationsCount(conversations.length);
    } catch (e) {
      console.error("Failed to fetch conversations", e);
    }
  };

  const handleXmtpDisconnect = async () => {
    console.log("App: XMTP Disconnected");
    xmtpConnectionGenerationRef.current += 1;
    const clientToClose = xmtpClientRef.current;
    xmtpClientRef.current = null;
    isXmtpConnectingRef.current = false;
    setXmtpClient(null);
    setUserAddress(null);
    setXmtpStatus('disconnected');
    setIsXmtpConnecting(false);
    try {
      await stopCollaboration();
    } catch (error) {
      console.warn('Could not stop the collaboration session cleanly', error);
    } finally {
      clientToClose?.close();
    }
  };

  const handleXmtpError = (errorMessage: string) => {
    console.error("App: XMTP Error", errorMessage);
    xmtpConnectionGenerationRef.current += 1;
    const clientToClose = xmtpClientRef.current;
    xmtpClientRef.current = null;
    isXmtpConnectingRef.current = false;
    setXmtpClient(null);
    setUserAddress(null);
    setXmtpStatus('error');
    setIsXmtpConnecting(false);
    void stopCollaboration()
      .catch((error) => console.warn('Could not stop the failed collaboration session', error))
      .finally(() => clientToClose?.close());
  };

  const handleXmtpToggleNetwork = async () => {
    if (isXmtpConnecting) return;
    console.log("App: Toggling XMTP Network...");
    const newEnv = xmtpNetworkEnv === 'dev' ? 'production' : 'dev';
    await handleXmtpDisconnect();
    setXmtpNetworkEnv(newEnv);
    setTimeout(() => void handleXmtpConnectAttempt(newEnv), 100);
  };

  const handleCreateNotebook = async (name: string) => {
    try {
      const newNotebook = await dbService.createNotebook({ name });
      setNotebooks(prev => [...prev, newNotebook]);
      setSelectedNotebookIdAndStore(newNotebook.id);
      showToast('Success', `Notebook "${name}" created`);
    } catch (error) {
      console.error('Failed to create notebook:', error);
      showToast('Error', 'Failed to create notebook', 'destructive');
    }
  };

  const handleRenameNotebook = async (notebookId: string, newName: string) => {
    try {
      const updatedNotebook = await dbService.updateNotebook(notebookId, { name: newName });
      if (updatedNotebook) {
        setNotebooks(prev => prev.map(nb => nb.id === notebookId ? updatedNotebook : nb));
        broadcastNotebookRename(notebookId, updatedNotebook.name, updatedNotebook.updatedAt);
        showToast('Success', 'Notebook renamed');
      }
    } catch (error) {
      console.error('Failed to rename notebook:', error);
      showToast('Error', 'Failed to rename notebook', 'destructive');
    }
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
      if (sessionNotebookId === notebookId) await stopCollaboration();
      const success = await dbService.deleteNotebook(notebookId);
      if (success) {
        showToast('Success', `Notebook "${notebookToDelete.name}" deleted.`);
        const remainingNotebooks = notebooks.filter(nb => nb.id !== notebookId);
        setNotebooks(remainingNotebooks);

        // Select the first remaining notebook or null if none left
        const newSelectedId = remainingNotebooks[0]?.id || null;
        setSelectedNotebookIdAndStore(newSelectedId);
        if (!newSelectedId) {
          // Clear notes/folders if no notebook is selected
          setNotes([]);
          setFolders([]);
          setOpenNoteIdsAndStore([]);
          setActiveNoteIdAndStore(null);
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
      const fileName = file.name.toLowerCase();
      if (!fileName.endsWith('.json.encrypted') && !fileName.endsWith('.json')) {
        showToast('Error', 'Invalid file type. Please select a .json or .json.encrypted file.', 'destructive');
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
      setSelectedNotebookIdAndStore(newNotebook.id); // Select the newly imported notebook
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
            STORMDANCE needs to update its database schema, but another tab might be blocking it.
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
    <div className="flex min-h-screen flex-col bg-transparent text-gray-900 dark:text-gray-100 font-sans antialiased px-3 pb-4 lg:h-screen lg:overflow-hidden lg:px-6">
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
        connectedNotebooksCount={notebooks.filter(
          (notebook) => !!getNotebookConversationId(notebook, xmtpNetworkEnv),
        ).length}
        hasIdentity={hasIdentity}
        onCreateIdentity={handleCreateIdentity}
        activeConversationsCount={activeConversationsCount}
        debugLoggingEnabled={debugLoggingEnabled}
        setDebugLoggingEnabled={setDebugLoggingEnabled}
      />
      <div
        id="workspace-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {workspaceStatus}
      </div>

      <main
        className="min-h-0 flex-1 overflow-hidden pt-2"
        aria-label="Stormdance workspace"
        aria-keyshortcuts="Tab Shift+Tab Control+Alt+N Meta+Alt+N Control+Alt+S Meta+Alt+S Control+Alt+[ Meta+Alt+[ Control+Alt+] Meta+Alt+] Control+Alt+1 Meta+Alt+1 Control+Alt+2 Meta+Alt+2 Control+Alt+3 Meta+Alt+3"
      >
        <div className="flex h-full min-h-0 flex-col gap-3 lg:flex-row lg:gap-4">
          <div
            className="w-full lg:w-1/3 xl:w-1/4 min-h-[38vh] lg:min-h-0 lg:max-w-[360px] border border-gray-200/70 dark:border-gray-800/70 flex flex-col bg-white/80 dark:bg-gray-950/70 rounded-2xl backdrop-blur mobile-card"
            onFocusCapture={() => setActiveColumn('notebooks')}
          >
            <Sidebar
              ref={sidebarRef}
              notebooks={notebooks}
              selectedNotebookId={selectedNotebookId}
              notes={notes}
              folders={folders}
              selectedNoteId={activeNoteId}
              onSelectNotebook={setSelectedNotebookIdAndStore}
              onSelectNote={handleSelectNote}
              onCreateNote={handleCreateNote}
              onDeleteNote={handleDeleteNote}
              onCreateFolder={handleCreateFolder}
              onDeleteFolder={handleDeleteFolder}
              onUpdateFolder={handleUpdateFolder}
              onCreateNotebook={handleCreateNotebook}
              onRenameNotebook={handleRenameNotebook}
              onDeleteNotebook={handleDeleteNotebook}
              onMoveNoteToFolder={handleMoveNoteToFolder}
              onMoveFolder={handleMoveFolder}
              isLoading={isLoading}
              containerRef={notesColumnRef}
              editorTitleInputRef={editorTitleInputRef}
              collaborationContacts={collaborationContacts}
              collaborationContactsNotebookId={collaborationContactsNotebookId}
              collaborationNotebookId={sessionNotebookId}
              notebookCollaborators={notebookCollaborators}
              collaboratorsPending={collaboratorsPending}
              collaborationStatus={collaborationStatus}
              collaborationTopic={sessionTopic}
              collaborationError={collaborationError || undefined}
              collaboratorsError={collaboratorsError || undefined}
              xmtpEnv={xmtpNetworkEnv}
              isXmtpConnected={xmtpStatus === 'connected'}
              onAddCollaborator={addContact}
              onRemoveCollaborator={removeContact}
              onRefreshCollaborators={refreshCollaborators}
              onAddNotebookCollaborator={addNotebookCollaborator}
              onChangeNotebookCollaboratorRole={changeNotebookCollaboratorRole}
              onRemoveNotebookCollaborator={removeNotebookCollaborator}
              onStartCollaborating={(notebookId, notebookName) => startCollaboration(notebookId || '', notebookName)}
              onStopCollaborating={stopCollaboration}
            />
          </div>

          <div
            className="flex min-h-[50vh] flex-1 flex-col lg:min-h-0"
            ref={editorRef}
            tabIndex={0}
            onFocus={() => setActiveColumn('editor')}
            role="region"
            aria-label={activeNote ? `Editor for note ${activeNote.title || 'Untitled'}` : 'Editor'}
          >
            {isLoading ? (
              <div className="flex items-center justify-center h-full rounded-2xl border border-gray-200/70 dark:border-gray-800/70 bg-white/80 dark:bg-gray-900/80 mobile-card text-muted-foreground">
                Loading...
              </div>
            ) : openNoteIds.length > 0 ? (
              <div className="flex h-full min-h-0 flex-col rounded-2xl border border-gray-200/70 dark:border-gray-800/70 bg-white/80 dark:bg-gray-900/80 shadow-lg shadow-gray-900/5 dark:shadow-black/20 backdrop-blur mobile-card">
                <EditorTabs
                  notes={notes}
                  openNoteIds={openNoteIds}
                  activeNoteId={activeNoteId}
                  onSelectTab={setActiveNoteIdAndStore}
                  onCloseTab={handleCloseTab}
                />
                <div className="min-h-0 flex-1 overflow-auto scrollbar-thin scrollbar-thumb-gray-300 hover:scrollbar-thumb-gray-400 dark:scrollbar-thumb-gray-600 dark:hover:scrollbar-thumb-gray-500 p-4 lg:p-6">
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

      {inviteDetails && (
        <CollaborationInviteModal
          isOpen={inviteModalOpen}
          inviterName={inviteDetails.inviterName}
          notebookName={inviteDetails.notebookName}
          onAccept={() => void acceptInvite()}
          onReject={() => void rejectInvite()}
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
