import React, { useState, useEffect, useRef, RefObject, KeyboardEvent, forwardRef, useImperativeHandle } from 'react';
import { Plus, Trash2, Book, Loader2, ChevronRight, ChevronDown, Folder as FolderIcon, Edit2, Info, Key, AlertCircle, Download, Users } from 'lucide-react';
import { Note, Notebook, Folder, dbService } from '../../lib/db';
import { XmtpConnect } from '../xmtp/XmtpConnect';
import type { BrowserClient } from '@/lib/xmtp-browser-sdk';
import { encryptBackup } from '../../lib/cryptoUtils';
import { saveAs } from 'file-saver';
import { NotebookCollaborationPanel } from './NotebookCollaborationPanel'; // Can remove if unused
import { CollaborationManagerModal } from '@/components/collaboration/CollaborationManagerModal';
import { CollaborationContact } from '@/lib/collaboration/types';
import { CollaborationStatus } from '@/hooks/useNotebookCollaboration';
import { CreateNotebookModal } from './CreateNotebookModal';

// Define the handle type that will be exposed
export interface SidebarHandle {
  focusItem: (type: 'note' | 'folder' | null, id: string | null) => void;
}

interface SidebarProps {
  // Updated XMTP props
  xmtpClient?: BrowserClient | null;
  onXmtpConnected: (client: BrowserClient, address: string, env: 'dev' | 'production') => void;
  onXmtpDisconnected: () => void;
  onXmtpError: (errorMessage: string) => void;
  initialXmtpNetworkEnv: 'dev' | 'production';
  triggerXmtpConnect: boolean;
  triggerXmtpDisconnect: boolean;

  // Existing props
  notebooks: Notebook[];
  selectedNotebookId: string | null;
  notes: Note[];
  folders: Folder[];
  selectedNoteId: string | null;
  onSelectNotebook: (notebookId: string) => void;
  onSelectNote: (note: Note) => void;
  onCreateNote: (folderId?: string | null) => Promise<Note | null>;
  onDeleteNote: (noteId: string) => void;
  onCreateFolder: (name: string, parentFolderId: string | null) => Promise<void>;
  onDeleteFolder: (folderId: string) => Promise<void>;
  onUpdateFolder: (folderId: string, updates: Partial<Omit<Folder, 'id' | 'createdAt' | 'updatedAt' | 'notebookId'>>) => Promise<void>;
  onCreateNotebook: (name: string) => Promise<void>;
  onRenameNotebook: (notebookId: string, newName: string) => Promise<void>;
  onDeleteNotebook: (notebookId: string | null) => Promise<void>;
  onMoveNoteToFolder: (noteId: string, folderId: string | null) => Promise<void>;
  onMoveFolder: (folderId: string, targetParentFolderId: string | null) => Promise<void>;
  isLoading: boolean;
  containerRef?: RefObject<HTMLDivElement>;
  editorTitleInputRef?: RefObject<HTMLInputElement>;

  // Collaboration
  collaborationContacts: CollaborationContact[];
  collaborationStatus: CollaborationStatus;
  collaborationTopic: string | null;
  collaborationError?: string | null;
  xmtpEnv: 'dev' | 'production';
  isXmtpConnected: boolean;
  onAddCollaborator: (value: string) => Promise<void>;
  onRemoveCollaborator: (address: string) => void;
  onStartCollaborating: (notebookId: string | null, notebookName: string) => Promise<void>;
  onStopCollaborating: () => Promise<void>;
}

// Wrap component with forwardRef
export const Sidebar = forwardRef<SidebarHandle, SidebarProps>((
  {
    // Updated XMTP props
    xmtpClient,
    onXmtpConnected,
    onXmtpDisconnected,
    onXmtpError,
    initialXmtpNetworkEnv,
    triggerXmtpConnect,
    triggerXmtpDisconnect,

    // Existing props
    notebooks,
    selectedNotebookId,
    notes,
    folders,
    selectedNoteId,
    onSelectNotebook,
    onSelectNote,
    onCreateNote,
    onDeleteNote,
    onCreateFolder,
    onDeleteFolder,
    onUpdateFolder,
    onCreateNotebook,
    onRenameNotebook,
    onDeleteNotebook,
    onMoveNoteToFolder,
    onMoveFolder,
    isLoading,
    containerRef,
    editorTitleInputRef,
    collaborationContacts,
    collaborationStatus,
    collaborationTopic,
    collaborationError,
    xmtpEnv,
    isXmtpConnected,
    onAddCollaborator,
    onRemoveCollaborator,
    onStartCollaborating,
    onStopCollaborating
  }, ref) => {

  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderParentId, setNewFolderParentId] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
  const [draggedItemType, setDraggedItemType] = useState<'note' | 'folder' | null>(null);
  const [dragOverTargetId, setDragOverTargetId] = useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [folderNewName, setFolderNewName] = useState('');
  const [infoModalNotebook, setInfoModalNotebook] = useState<Notebook | null>(null);
  const [isCollaborationModalOpen, setIsCollaborationModalOpen] = useState(false);
  const [isCreateNotebookModalOpen, setIsCreateNotebookModalOpen] = useState(false);
  const [renamingNotebookId, setRenamingNotebookId] = useState<string | null>(null);
  const [notebookNewName, setNotebookNewName] = useState('');

  // Refs for focusable elements (folders and notes)
  const itemRefs = useRef<Map<string, HTMLElement>>(new Map());

  // Helper to register refs
  const registerRef = (type: 'folder' | 'note', id: string) => (el: HTMLElement | null) => {
    const key = `${type}-${id}`;
    if (el) {
      itemRefs.current.set(key, el);
    } else {
      itemRefs.current.delete(key);
    }
  };

  const handleCreateFolderSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFolderName.trim()) return;
    try {
      await onCreateFolder(newFolderName.trim(), newFolderParentId);
      setNewFolderName('');
      setIsCreatingFolder(false);
      setNewFolderParentId(null);
    } catch (error) {
      console.error('Failed to create folder:', error);
    }
  };

  const handleRenameFolderClick = (folder: Folder) => {
    setRenamingFolderId(folder.id);
    setFolderNewName(folder.name);
  };

  const handleRenameFolderSubmit = async (e: React.FormEvent | React.FocusEvent) => {
    e.preventDefault();
    if (!renamingFolderId || !folderNewName.trim()) {
      setRenamingFolderId(null); // Cancel if empty name on blur
      return;
    }
    const originalFolder = folders.find(f => f.id === renamingFolderId);
    if (originalFolder && originalFolder.name === folderNewName.trim()) {
      setRenamingFolderId(null); // Cancel if name didn't change
      itemRefs.current.get(`folder-${renamingFolderId}`)?.focus();
      return;
    }

    try {
      await onUpdateFolder(renamingFolderId, { name: folderNewName.trim() });
      const justRenamedId = renamingFolderId; // Store ID before resetting state
      setRenamingFolderId(null);
      setFolderNewName('');
      // Focus back to the folder element after renaming
      setTimeout(() => itemRefs.current.get(`folder-${justRenamedId}`)?.focus(), 0);
    } catch (error) {
      console.error('Failed to rename folder:', error);
      setRenamingFolderId(null); // Ensure reset even on error
    }
  };

  const handleRenameNotebookClick = (notebook: Notebook) => {
    setRenamingNotebookId(notebook.id);
    setNotebookNewName(notebook.name);
  };

  const handleRenameNotebookSubmit = async (e: React.FormEvent | React.FocusEvent) => {
    e.preventDefault();
    if (!renamingNotebookId || !notebookNewName.trim()) {
      setRenamingNotebookId(null);
      return;
    }
    const originalNotebook = notebooks.find(n => n.id === renamingNotebookId);
    if (originalNotebook && originalNotebook.name === notebookNewName.trim()) {
      setRenamingNotebookId(null);
      return;
    }

    try {
      await onRenameNotebook(renamingNotebookId, notebookNewName.trim());
      setRenamingNotebookId(null);
      setNotebookNewName('');
    } catch (error) {
      console.error('Failed to rename notebook:', error);
      setRenamingNotebookId(null);
    }
  };

  const toggleFolder = (folderId: string) => {
    setExpandedFolders(prev => {
      const newSet = new Set(prev);
      if (newSet.has(folderId)) {
        newSet.delete(folderId);
      } else {
        newSet.add(folderId);
      }
      return newSet;
    });
  };

  // --- Helper functions for folder/note retrieval ---
  const getRootFolders = () => folders.filter(f => f.parentFolderId === null && f.notebookId === selectedNotebookId).sort((a, b) => a.name.localeCompare(b.name));
  const getChildFolders = (parentId: string) => folders.filter(f => f.parentFolderId === parentId).sort((a, b) => a.name.localeCompare(b.name));
  const getNotesInFolder = (folderId: string | null) => notes.filter(n => n.folderId === folderId && n.notebookId === selectedNotebookId).sort((a, b) => (a.title || '').localeCompare(b.title || ''));

  // --- Helper function to get flattened list of visible items (defined outside useImperativeHandle) ---
  const getOrderedElements = (): HTMLElement[] => {
    const orderedElements: HTMLElement[] = [];
    const rootFolders = getRootFolders();
    const rootNotes = getNotesInFolder(null);

    const traverse = (folderId: string) => {
      const folderElement = itemRefs.current.get(`folder-${folderId}`);
      if (folderElement) orderedElements.push(folderElement);

      if (expandedFolders.has(folderId)) {
        const children = getChildFolders(folderId);
        children.forEach(child => traverse(child.id));
        const notesInside = getNotesInFolder(folderId);
        notesInside.forEach(note => {
          const noteElement = itemRefs.current.get(`note-${note.id}`);
          if (noteElement) orderedElements.push(noteElement);
        });
      }
    };

    rootFolders.forEach(folder => traverse(folder.id));
    rootNotes.forEach(note => {
      const noteElement = itemRefs.current.get(`note-${note.id}`);
      if (noteElement) orderedElements.push(noteElement);
    });

    return orderedElements;
  };

  // --- Keyboard Navigation Logic ---
  useEffect(() => {
    const sidebarElement = containerRef?.current;
    if (!sidebarElement) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if editing inputs/textareas or in specific UI states
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        isCreatingFolder ||
        renamingFolderId !== null
      ) {
        return;
      }

      const activeElement = document.activeElement as HTMLElement;
      const orderedElements = getOrderedElements();
      const currentIndex = orderedElements.findIndex(el => el === activeElement);

      const folderIdAttr = activeElement?.getAttribute('data-folder-id');
      const noteIdAttr = activeElement?.getAttribute('data-note-id');
      const currentItemType = folderIdAttr ? 'folder' : (noteIdAttr ? 'note' : null);

      // --- N Key: Create New Note IN CONTEXT ---
      if (e.key === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (selectedNotebookId) {
          let targetFolderId: string | null = null;

          if (currentItemType === 'folder') {
            // If a folder is focused, create the note inside it
            targetFolderId = folderIdAttr;
          } else if (currentItemType === 'note') {
            // If a note is focused, create the new note in the same folder as that note
            const focusedNote = notes.find(n => n.id === noteIdAttr);
            targetFolderId = focusedNote?.folderId || null;
          } else {
            // If nothing specific is focused in the list (or focus is on root drop area?),
            // create in the root (null folderId)
            targetFolderId = null;
          }

          console.log(`Sidebar: 'n' pressed, creating note in folder ${targetFolderId}`); // Debug log
          onCreateNote(targetFolderId).then(newNote => {
            if (newNote) {
              // Focus the new note in the sidebar first, then the title
              setTimeout(() => itemRefs.current.get(`note-${newNote.id}`)?.focus(), 0);
              setTimeout(() => editorTitleInputRef?.current?.focus(), 50);
            }
          });
        }
        return; // Handled
      }

      // --- Arrow Down/Up Navigation ---
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (orderedElements.length === 0) return;

        let nextIndex = currentIndex;
        if (currentIndex === -1) {
          // If nothing is focused, focus the first item
          nextIndex = 0;
        } else if (e.key === 'ArrowDown') {
          nextIndex = (currentIndex + 1) % orderedElements.length;
        } else { // ArrowUp
          nextIndex = (currentIndex - 1 + orderedElements.length) % orderedElements.length;
        }
        orderedElements[nextIndex]?.focus();
        return;
      }

      // --- Actions on Currently Focused Item (Requires an item to be focused) ---
      if (currentIndex < 0 || !currentItemType) return;

      // --- Left/Right Arrows: Collapse/Expand Folder ---
      if (currentItemType === 'folder' && folderIdAttr && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        const isExpanded = expandedFolders.has(folderIdAttr);

        if (e.key === 'ArrowLeft') {
          if (isExpanded) {
            toggleFolder(folderIdAttr);
          } else {
            // Navigate to parent folder if possible
            const folder = folders.find(f => f.id === folderIdAttr);
            if (folder?.parentFolderId) {
              itemRefs.current.get(`folder-${folder.parentFolderId}`)?.focus();
            }
          }
        } else if (e.key === 'ArrowRight') {
          if (!isExpanded) {
            toggleFolder(folderIdAttr);
          } else {
            // Navigate to first child if possible
            const firstChildElement = orderedElements[currentIndex + 1];
            const firstChildFolderId = firstChildElement?.getAttribute('data-folder-id');
            const firstChildNoteId = firstChildElement?.getAttribute('data-note-id');
            const folder = folders.find(f => f.id === folderIdAttr);

            if (folder && firstChildElement) {
              const isChild = (firstChildFolderId && folders.find(f => f.id === firstChildFolderId)?.parentFolderId === folderIdAttr) ||
                (firstChildNoteId && notes.find(n => n.id === firstChildNoteId)?.folderId === folderIdAttr);
              if (isChild) {
                firstChildElement.focus();
              }
            }
          }
        }
        return;
      }

      // --- Enter Key: Select Note or Toggle Folder ---
      if (e.key === 'Enter') {
        e.preventDefault();
        if (currentItemType === 'note' && noteIdAttr) {
          const note = notes.find(n => n.id === noteIdAttr);
          if (note) onSelectNote(note);
        } else if (currentItemType === 'folder' && folderIdAttr) {
          toggleFolder(folderIdAttr);
        }
        return;
      }
    };

    sidebarElement.addEventListener('keydown', handleKeyDown as any);
    return () => {
      sidebarElement.removeEventListener('keydown', handleKeyDown as any);
    };
  }, [
    // Updated dependencies
    containerRef,
    notes, // Needed to find folderId of focused note
    folders,
    expandedFolders,
    selectedNotebookId,
    isCreatingFolder,
    renamingFolderId,
    onCreateNote, // Add onCreateNote
    onSelectNote,
    toggleFolder,
    editorTitleInputRef
  ]);

  // --- Drag and Drop Handlers ---
  const handleDragStart = (e: React.DragEvent, type: 'note' | 'folder', id: string) => {
    setDraggedItemId(id);
    setDraggedItemType(type);
    e.dataTransfer.setData('application/json', JSON.stringify({ type, id }));
    e.stopPropagation(); // Prevent interference if nested
  };

  const handleDragOver = (e: React.DragEvent, targetFolderId: string | null) => {
    e.preventDefault(); // Necessary to allow dropping
    e.stopPropagation();

    if (!draggedItemId || !draggedItemType) return;

    // Logic to prevent dropping folder into itself or descendants (checked on drop, but good for UI feedback too)
    let isValidTarget = true;
    if (draggedItemType === 'folder') {
      if (draggedItemId === targetFolderId) {
        isValidTarget = false; // Can't drop onto self
      }
      // Add descendant check here if needed for visual feedback (complex)
    }

    if (isValidTarget) {
      setDragOverTargetId(targetFolderId);
      e.dataTransfer.dropEffect = 'move';
    } else {
      setDragOverTargetId('invalid'); // Use a special value or null
      e.dataTransfer.dropEffect = 'none';
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    // Check if leaving to a valid child or outside relevant area
    // This logic can be tricky; simpler might be to just clear on drop/end
    const relatedTarget = e.relatedTarget as Node | null;
    // A simple check: If the related target is outside the sidebar container, clear the highlight.
    // More robust checks might involve checking if relatedTarget is still within a valid drop zone.
    if (!containerRef?.current?.contains(relatedTarget)) {
      setDragOverTargetId(null);
    }
    // A simpler alternative: rely mostly on handleDragOver and handleDrop/End to clear state.
    // setDragOverTargetId(null); // This might flicker
  };

  const handleDragEnd = (_e: React.DragEvent) => {
    // Always clear drag state when drag operation ends (successfully or not)
    setDraggedItemId(null);
    setDraggedItemType(null);
    setDragOverTargetId(null);
  };

  const handleDrop = async (e: React.DragEvent, targetFolderId: string | null) => {
    e.preventDefault();
    e.stopPropagation();

    const droppedData = e.dataTransfer.getData('application/json');
    if (!droppedData) {
      setDragOverTargetId(null);
      setDraggedItemId(null);
      setDraggedItemType(null);
      return;
    }

    let parsedData: { type: 'note' | 'folder', id: string };
    try {
      parsedData = JSON.parse(droppedData);
    } catch (err) {
      console.error("Error parsing drag data:", err);
      setDragOverTargetId(null);
      setDraggedItemId(null);
      setDraggedItemType(null);
      return;
    }

    const { type: droppedItemType, id: droppedItemId } = parsedData;

    // Prevent dropping onto self (though DB service also checks)
    if (droppedItemType === 'folder' && droppedItemId === targetFolderId) {
      setDragOverTargetId(null);
      setDraggedItemId(null);
      setDraggedItemType(null);
      return;
    }

    // Call the appropriate move handler
    try {
      if (droppedItemType === 'note') {
        const note = notes.find(n => n.id === droppedItemId);
        if (note && note.folderId !== (targetFolderId || null)) {
          await onMoveNoteToFolder(droppedItemId, targetFolderId);
        }
      } else if (droppedItemType === 'folder') {
        const folder = folders.find(f => f.id === droppedItemId);
        if (folder && folder.parentFolderId !== (targetFolderId || null)) {
          await onMoveFolder(droppedItemId, targetFolderId);
        }
      }

      // Expand target folder after a successful drop
      if (targetFolderId && !expandedFolders.has(targetFolderId)) {
        toggleFolder(targetFolderId);
      }

    } catch (error) {
      console.error(`Failed to move ${droppedItemType}:`, error);
    } finally {
      // Reset drag state regardless of success/failure
      setDragOverTargetId(null);
      setDraggedItemId(null);
      setDraggedItemType(null);
    }
  };

  // --- Render Functions ---
  const renderFolderTree = (parentFolderId: string | null, depth: number = 0): JSX.Element[] => {
    const folderList = parentFolderId === null ? getRootFolders() : getChildFolders(parentFolderId);
    const noteList = getNotesInFolder(parentFolderId);
    let renderedElements: JSX.Element[] = [];

    folderList.forEach(folder => {
      const isExpanded = expandedFolders.has(folder.id);
      const isDragOver = dragOverTargetId === folder.id;
      const isBeingDragged = draggedItemType === 'folder' && draggedItemId === folder.id;
      const isRenaming = renamingFolderId === folder.id;

      renderedElements.push(
        <li key={`folder-${folder.id}`} className={`ml-${depth * 2} mb-px ${isBeingDragged ? 'opacity-40' : ''} list-none`}>
          <div
            className={`flex items-center group rounded-sm ${isDragOver ? 'bg-yellow-200 dark:bg-yellow-800/40' : ''} focus-within:bg-yellow-100 dark:focus-within:bg-yellow-900/30`}
            onDragOver={(e) => handleDragOver(e, folder.id)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, folder.id)}
            draggable={!isRenaming} // Prevent dragging while renaming
            onDragStart={!isRenaming ? (e) => handleDragStart(e, 'folder', folder.id) : undefined}
            onDragEnd={handleDragEnd} // Add drag end handler
            ref={registerRef('folder', folder.id)}
            tabIndex={-1}
            data-folder-id={folder.id}
            aria-expanded={isExpanded}
          >
            <button
              onClick={() => toggleFolder(folder.id)}
              className="p-1 mr-1 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-sm focus:outline-none focus:ring-1 focus:ring-yellow-400"
              aria-label={isExpanded ? `Collapse ${folder.name}` : `Expand ${folder.name}`}
              tabIndex={-1}
            >
              {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>
            {isRenaming ? (
              <form onSubmit={handleRenameFolderSubmit} className="flex-1 folder-edit-form">
                <input
                  type="text"
                  value={folderNewName}
                  onChange={(e) => setFolderNewName(e.target.value)}
                  className="flex-1 folder-edit-input p-0.5 text-sm bg-white dark:bg-gray-800 border border-yellow-400 rounded-sm focus:outline-none dark:text-gray-100"
                  autoFocus
                  onBlur={handleRenameFolderSubmit} // Save on blur too
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') { e.stopPropagation(); setRenamingFolderId(null); itemRefs.current.get(`folder-${folder.id}`)?.focus(); }
                    if (e.key === 'Enter') { e.stopPropagation(); handleRenameFolderSubmit(e); }
                  }}
                />
              </form>
            ) : (
              <>
                <div className="flex items-center flex-1 p-1 rounded-sm group-hover:bg-gray-100 dark:group-hover:bg-gray-800 text-gray-800 dark:text-gray-200">
                  <FolderIcon size={16} className="mr-1 text-gray-500 dark:text-gray-400 flex-shrink-0" />
                  <span className="text-sm truncate select-none flex-1">{folder.name}</span>
                </div>
                <button
                  className="p-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 text-yellow-600 dark:text-yellow-400 hover:bg-yellow-100 dark:hover:bg-gray-700 rounded-sm focus:outline-none focus:ring-1 focus:ring-yellow-400 mr-1"
                  onClick={(e) => { e.stopPropagation(); handleRenameFolderClick(folder); }}
                  title="Rename folder"
                  aria-label={`Rename folder ${folder.name}`}
                  tabIndex={-1}
                >
                  <Edit2 size={14} />
                </button>
                <button
                  className="p-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 text-red-500 hover:bg-red-100 dark:hover:bg-gray-700 rounded-sm focus:outline-none focus:ring-1 focus:ring-red-400"
                  onClick={(e) => { e.stopPropagation(); onDeleteFolder(folder.id); }}
                  title="Delete folder"
                  aria-label={`Delete folder ${folder.name}`}
                  tabIndex={-1}
                >
                  <Trash2 size={14} />
                </button>
              </>
            )}
          </div>
          {isExpanded && (
            <ul className="pl-4" role="group"> {/* Add role group for nested list */}
              {renderFolderTree(folder.id, depth + 1)}
            </ul>
          )}
        </li>
      );
    });

    noteList.forEach(note => {
      const isBeingDragged = draggedItemType === 'note' && draggedItemId === note.id;
      renderedElements.push(
        <li
          key={`note-${note.id}`}
          className={`relative group ml-${depth * 2} list-none ${isBeingDragged ? 'opacity-40' : ''}`}
          draggable
          onDragStart={(e) => handleDragStart(e, 'note', note.id)}
          onDragEnd={handleDragEnd} // Add drag end handler
        >
          <button
            className={`w-full text-left px-3 py-1 my-px rounded-sm text-sm draggable-note focus:outline-none focus:ring-1 focus:ring-yellow-400 focus:bg-yellow-100 dark:focus:bg-yellow-900/30 ${selectedNoteId === note.id ? 'bg-yellow-100 dark:bg-yellow-900/30 font-medium text-yellow-900 dark:text-yellow-100' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
            onClick={() => onSelectNote(note)}
            data-note-id={note.id}
            ref={registerRef('note', note.id)}
            tabIndex={-1}
          >
            <span className="block truncate select-none">{note.title || 'Untitled'}</span>
          </button>
          <button
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-sm opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-red-100 dark:hover:bg-gray-700 text-red-600 focus:outline-none focus:ring-1 focus:ring-red-400"
            onClick={(e) => { e.stopPropagation(); onDeleteNote(note.id); }}
            title="Delete note"
            aria-label={`Delete note ${note.title || 'Untitled'}`}
            tabIndex={-1}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </li>
      );
    });

    return renderedElements;
  };

  // --- Imperative Handle --- (Expose focusItem method)
  useImperativeHandle(ref, () => ({
    focusItem: (type, id) => {
      let targetKey: string | null = null;
      if (type && id) {
        targetKey = `${type}-${id}`;
      } else {
        // If no specific item, try focusing the first visible item
        const firstElement = getOrderedElements()[0]; // Now accessible
        if (firstElement) {
          const folderId = firstElement.getAttribute('data-folder-id');
          const noteId = firstElement.getAttribute('data-note-id');
          targetKey = folderId ? `folder-${folderId}` : (noteId ? `note-${noteId}` : null);
        }
      }

      if (targetKey) {
        const elementToFocus = itemRefs.current.get(targetKey);
        elementToFocus?.focus();
      } else {
        // Fallback: focus the container itself if no specific item found
        containerRef?.current?.focus();
      }
    }
  }));

  // Pass the xmtpClient to the connection status indicator
  const xmtpConnected = !!xmtpClient;
  const selectedNotebook = notebooks.find(nb => nb.id === selectedNotebookId) || null;

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="h-full flex flex-col border-r focus:outline-none"
    >

      <div className="p-4 flex-col space-y-2 border-b border-gray-200 dark:border-yellow-400/50 bg-transparent dark:bg-gray-900">
        <div className="flex justify-between items-center">
          <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200">Notebooks</h2>
          <div className="flex space-x-1">
            <button
              className="p-2 rounded-md hover:bg-gray-200 dark:hover:bg-gray-800 focus:outline-none focus:ring-1 focus:ring-yellow-400 text-gray-600 dark:text-gray-400"
              onClick={() => setIsCollaborationModalOpen(true)}
              aria-label="Collaborate"
              title="Collaborate"
              tabIndex={-1}
            >
              <Users className="h-5 w-5" />
            </button>
            <button
              className="p-2 rounded-md hover:bg-gray-200 dark:hover:bg-gray-800 focus:outline-none focus:ring-1 focus:ring-yellow-400"
              onClick={() => setIsCreateNotebookModalOpen(true)}
              aria-label="Create new notebook"
              tabIndex={-1}
            >
              <Plus className="h-5 w-5" />
            </button>
          </div>
        </div>
        {/* Notebook List */}
        <ul className="space-y-1 mt-2">
          {notebooks.map((notebook) => (
            <li key={notebook.id} className="relative group">
              {renamingNotebookId === notebook.id ? (
                <form onSubmit={handleRenameNotebookSubmit} className="w-full px-3 py-2">
                  <input
                    type="text"
                    value={notebookNewName}
                    onChange={(e) => setNotebookNewName(e.target.value)}
                    className="w-full p-1 text-sm bg-white dark:bg-gray-800 border border-yellow-400 rounded-sm focus:outline-none dark:text-gray-100"
                    autoFocus
                    onBlur={handleRenameNotebookSubmit}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') { e.stopPropagation(); setRenamingNotebookId(null); }
                      if (e.key === 'Enter') { e.stopPropagation(); handleRenameNotebookSubmit(e); }
                    }}
                  />
                </form>
              ) : (
                <>
                  <button
                    className={`w-full flex items-center px-3 py-2 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-yellow-400 ${selectedNotebookId === notebook.id ? "bg-gray-200 dark:bg-yellow-900/30 font-medium dark:text-yellow-100" : "text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"}`}
                    onClick={() => onSelectNotebook(notebook.id)}
                    tabIndex={-1}
                    data-notebook-id={notebook.id}
                  >
                    <Book className="h-4 w-4 mr-2 flex-shrink-0 text-gray-500 dark:text-gray-400" />
                    <span className="truncate flex-1 text-left">{notebook.name}</span>
                  </button>
                  <div className={`absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2 w-auto transition-opacity bg-white dark:bg-gray-900 pl-3 pr-2 py-1 rounded-l-md shadow-[-12px_0_12px_-6px_rgba(255,255,255,1)] dark:shadow-[-12px_0_12px_-6px_rgba(17,24,39,1)] z-10 ${selectedNotebookId === notebook.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                    <button
                      className="p-1.5 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 focus:outline-none focus:ring-1 focus:ring-yellow-400 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleRenameNotebookClick(notebook);
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      aria-label={`Rename notebook ${notebook.name}`}
                      title="Rename notebook"
                      tabIndex={0}
                    >
                      <Edit2 size={15} />
                    </button>
                    <button
                      className="p-1.5 text-gray-400 hover:text-red-600 dark:text-gray-500 dark:hover:text-red-400 focus:outline-none focus:ring-1 focus:ring-red-400 rounded hover:bg-red-50 dark:hover:bg-red-900/20"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onDeleteNotebook(notebook.id);
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      aria-label={`Delete notebook ${notebook.name}`}
                      title="Delete notebook"
                      tabIndex={0}
                    >
                      <Trash2 size={15} />
                    </button>
                    <button
                      className="p-1.5 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 focus:outline-none focus:ring-1 focus:ring-yellow-400 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setInfoModalNotebook(notebook);
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      aria-label={`Show info for notebook ${notebook.name}`}
                      title="Show notebook info"
                      tabIndex={0}
                    >
                      <Info size={15} />
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>

      {/* Folders and Notes Section */}
      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="p-4 flex justify-between items-center border-b border-gray-200 dark:border-yellow-400/50 bg-transparent dark:bg-gray-900">
          <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200">Notes</h2>
          {/* ... Create Folder/Note buttons ... */}
          <div className="flex">
            <button
              className="p-2 rounded-md hover:bg-gray-200 dark:hover:bg-gray-800 disabled:opacity-50 mr-1 focus:outline-none focus:ring-1 focus:ring-yellow-400"
              onClick={() => { setIsCreatingFolder(true); setNewFolderParentId(null); }}
              title="Create new folder"
              disabled={!selectedNotebookId || isLoading}
              aria-label="Create new root folder"
              tabIndex={-1}
            >
              <FolderIcon className="h-5 w-5" />
            </button>
            <button
              className="p-2 rounded-md hover:bg-gray-200 dark:hover:bg-gray-800 disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-yellow-400"
              onClick={() => onCreateNote()} // Use onCreateNote directly
              title="Create new note (n)"
              disabled={!selectedNotebookId || isLoading}
              aria-label="Create new note"
              tabIndex={-1}
            >
              <Plus className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* ... Folder Creation Form ... */}
        {isCreatingFolder && (
          <div className="px-4 py-2 border-b border-gray-200 dark:border-yellow-400/50 bg-transparent dark:bg-gray-900">
            <form onSubmit={handleCreateFolderSubmit} className="mt-2">
              <input
                type="text"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder="Folder name"
                className="w-full p-2 border rounded-md text-sm bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-600 placeholder-gray-400 dark:placeholder-gray-500 focus:ring-yellow-400 focus:border-yellow-400 dark:text-gray-100"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Escape') setIsCreatingFolder(false); }}
              />
              <div className="flex justify-end mt-2 space-x-2">
                <button
                  type="button"
                  onClick={() => setIsCreatingFolder(false)}
                  className="px-2 py-1 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-2 py-1 text-sm bg-yellow-500 text-black rounded-md hover:bg-yellow-600 dark:bg-yellow-400 dark:hover:bg-yellow-500"
                >
                  Create
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Tree View Area */}
        <div
          className="flex-1 overflow-auto p-2 bg-white dark:bg-gray-850 !important scrollbar-thin scrollbar-thumb-gray-300 hover:scrollbar-thumb-gray-400 dark:scrollbar-thumb-gray-600 dark:hover:scrollbar-thumb-gray-500"
          onDragOver={(e) => handleDragOver(e, null)} // Allow dropping on root area
          onDragLeave={handleDragLeave}
          onDrop={(e) => handleDrop(e, null)}
        >
          {isLoading ? (
            <div className="flex items-center justify-center h-20 text-gray-500 dark:text-gray-400"><Loader2 className="mr-2 h-4 w-4 animate-spin text-gray-500 dark:text-gray-400" /> Loading...</div>
          ) : !selectedNotebookId ? (
            <p className="text-center text-gray-500 dark:text-gray-400 p-4 italic">Select a notebook</p>
          ) : (folders.length === 0 && notes.filter(n => n.folderId === null && n.notebookId === selectedNotebookId).length === 0) ? (
            <p className="text-center text-gray-500 dark:text-gray-400 p-4 italic">No notes or folders yet</p>
          ) : (
            <ul
              className="space-y-px list-none p-0 m-0"
              aria-label="Notes and Folders"
              role="tree"
            // Removed drag handlers from ul, handled by the wrapping div now
            >
              {renderFolderTree(null)}
            </ul>
          )}
        </div>
      </div>

      {/* Render Modals */}
      <NotebookInfoModal
        notebook={infoModalNotebook}
        onClose={() => setInfoModalNotebook(null)}
        onDelete={onDeleteNotebook}
      />

      <CreateNotebookModal
        isOpen={isCreateNotebookModalOpen}
        onClose={() => setIsCreateNotebookModalOpen(false)}
        onCreate={onCreateNotebook}
      />

      <CollaborationManagerModal
        isOpen={isCollaborationModalOpen}
        onClose={() => setIsCollaborationModalOpen(false)}
        notebookName={selectedNotebook?.name}
        contacts={collaborationContacts}
        sessionTopic={collaborationTopic}
        status={collaborationStatus}
        error={collaborationError}
        isXmtpConnected={isXmtpConnected}
        onAddContact={onAddCollaborator}
        onRemoveContact={onRemoveCollaborator}
        onStartCollaboration={() => onStartCollaborating(selectedNotebookId, selectedNotebook?.name || 'Untitled Notebook')}
        onStopCollaboration={onStopCollaborating}
        xmtpEnv={xmtpEnv}
      />

    </div>
  );
});

// --- Password Prompt Modal (for Export) --- 
const ExportPasswordModal: React.FC<{ notebookName: string; onExport: (password: string) => void; onCancel: () => void }> = ({ notebookName, onExport, onCancel }) => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    if (!password) {
      setError("Password cannot be empty.");
      return;
    }
    // Optional: Add password strength check here
    setError(null);
    onExport(password);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={onCancel}>
      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-xl max-w-md w-full" onClick={e => e.stopPropagation()}>
        <h2 className="text-xl font-semibold mb-4 text-gray-900 dark:text-gray-100">Set Export Password</h2>
        <p className="mb-4 text-sm text-gray-600 dark:text-gray-300">Choose a strong password to encrypt the backup for <code className="bg-gray-100 dark:bg-gray-700 p-1 rounded text-xs">{notebookName}</code>. <strong className="text-red-600 dark:text-red-400">You MUST remember this password to restore the backup.</strong></p>
        <div className="relative mb-3">
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
            Encrypt & Export
          </button>
        </div>
      </div>
    </div>
  );
};

// --- Notebook Info Modal Component --- 
const NotebookInfoModal: React.FC<{
  notebook: Notebook | null;
  onClose: () => void;
  onDelete: (notebookId: string | null) => void;
}> = ({ notebook, onClose, onDelete }) => {
  const [isExporting, setIsExporting] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);

  if (!notebook) return null;

  const handleInitiateExport = () => {
    // Just open the password modal
    setShowPasswordModal(true);
  }

  const handleExportWithPassword = async (password: string) => {
    if (!notebook) {
      // Maybe use toast notification instead of modal error state
      console.error("Cannot export: Missing notebook data.");
      return;
    }
    setShowPasswordModal(false);
    setIsExporting(true);
    try {
      console.log(`Exporting notebook: ${notebook.id}`);
      const folders = await dbService.getAllFolders(notebook.id);
      const notes = await dbService.getAllNotes(notebook.id);

      // Create path structure
      const folderMap = new Map<string, Folder>();
      const folderPathMap = new Map<string, string>(); // Map ID to relative path
      folders.forEach(f => folderMap.set(f.id, f));

      const getPath = (folderId: string | null): string | null => {
        if (!folderId) return null;
        if (folderPathMap.has(folderId)) return folderPathMap.get(folderId)!;

        const folder = folderMap.get(folderId);
        if (!folder) return null; // Should not happen

        const parentPath = getPath(folder.parentFolderId);
        const currentPath = parentPath ? `${parentPath}/${folder.name}` : folder.name;
        folderPathMap.set(folderId, currentPath);
        return currentPath;
      };

      // Ensure all paths are generated
      folders.forEach(f => getPath(f.id));

      const exportData = {
        notebook: {
          id: notebook.id, // Include original ID for reference
          name: notebook.name,
        },
        folders: folders.map(f => ({
          id: f.id,
          name: f.name,
          parentPath: getPath(f.parentFolderId),
        })),
        notes: notes.map(n => ({
          id: n.id,
          folderPath: getPath(n.folderId),
          title: n.title,
          content: n.content,
          createdAt: n.createdAt,
          updatedAt: n.updatedAt,
        })),
      };

      // Encrypt using password
      const wrapperJson = await encryptBackup(password, exportData);

      // Create blob from the wrapper JSON string
      const blob = new Blob([JSON.stringify(wrapperJson, null, 2)], { type: 'application/json' });
      const filename = `${notebook.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}-backup.json.encrypted`; // New filename
      saveAs(blob, filename);

    } catch (error) {
      console.error("Export failed:", error);
      // Use toast notification for errors
      // Example: showToast('Export Failed', `...`, 'destructive');
    } finally {
      setIsExporting(false);
    }
  };

  const handleDeleteClick = () => {
    onDelete(notebook?.id ?? null);
    onClose(); // Close modal after initiating delete
  };

  // Simple modal styling - replace with a proper modal library later if needed
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-xl max-w-md w-full" onClick={e => e.stopPropagation()}>
        <h2 className="text-xl font-semibold mb-4 text-gray-900 dark:text-gray-100">Notebook Info: {notebook.name}</h2>
        <div className="space-y-2 text-sm">
          <p><strong className="text-gray-600 dark:text-gray-400">ID:</strong> <span className="text-gray-800 dark:text-gray-200 break-all">{notebook.id}</span></p>
          <p><strong className="text-gray-600 dark:text-gray-400">Created:</strong> <span className="text-gray-800 dark:text-gray-200">{new Date(notebook.createdAt).toLocaleString()}</span></p>
          <p><strong className="text-gray-600 dark:text-gray-400">Updated:</strong> <span className="text-gray-800 dark:text-gray-200">{new Date(notebook.updatedAt).toLocaleString()}</span></p>
        </div>
        <div className="mt-4 flex justify-between items-center">
          <div className="flex space-x-2">
            {/* Export Button */}
            <button
              onClick={handleInitiateExport}
              disabled={isExporting}
              className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-yellow-400 dark:text-black dark:hover:bg-yellow-500 flex items-center"
            >
              {isExporting ? 'Exporting...' : <><Download size={14} className="mr-1 inline-block" />Export</>}
            </button>
            {/* Delete Button */}
            <button
              onClick={handleDeleteClick}
              className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 flex items-center"
            >
              <Trash2 size={14} className="mr-1 inline-block" /> Delete
            </button>
          </div>
          <button onClick={onClose} className="px-4 py-2 bg-gray-200 dark:bg-gray-600 text-gray-800 dark:text-gray-100 rounded hover:bg-gray-300 dark:hover:bg-gray-500">
            Close
          </button>
        </div>
        {showPasswordModal && notebook && (
          <ExportPasswordModal
            notebookName={notebook.name}
            onExport={handleExportWithPassword}
            onCancel={() => setShowPasswordModal(false)}
          />
        )}
      </div>
    </div>
  );
};
