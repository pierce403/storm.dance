import React, { useState, useEffect, useRef, RefObject, KeyboardEvent, forwardRef, useImperativeHandle } from 'react';
import { Plus, Trash2, Book, Loader2, ChevronRight, ChevronDown, Folder as FolderIcon, Edit2 } from 'lucide-react';
import { Note, Notebook, Folder } from '../../lib/db';
import { XmtpConnect } from '../xmtp/XmtpConnect';
import { Client } from '@xmtp/xmtp-js';

// Type definition for focusable items in the list
type FocusableItem = {
  type: 'folder' | 'note';
  id: string;
  elementRef?: HTMLElement | null; // Store ref for focusing
};

// Define the handle type that will be exposed
export interface SidebarHandle {
  focusItem: (type: 'note' | 'folder' | null, id: string | null) => void;
}

interface SidebarProps {
  onXmtpConnect: (client: Client, address: string) => void;
  onXmtpDisconnect: () => void;
  notebooks: Notebook[];
  selectedNotebookId: string | null;
  notes: Note[];
  folders: Folder[];
  selectedNoteId: string | null;
  onSelectNotebook: (notebookId: string) => void;
  onCreateNotebook: (name: string) => Promise<Notebook | null>;
  onSelectNote: (note: Note) => void;
  onCreateNote: (folderId?: string | null) => Promise<Note | null>;
  onDeleteNote: (noteId: string) => void;
  onCreateFolder: (name: string, parentFolderId: string | null) => Promise<void>;
  onDeleteFolder: (folderId: string) => Promise<void>;
  onUpdateFolder: (folderId: string, updates: Partial<Omit<Folder, 'id' | 'createdAt' | 'updatedAt' | 'notebookId'>>) => Promise<void>;
  onMoveNoteToFolder: (noteId: string, folderId: string | null) => Promise<void>;
  onMoveFolder: (folderId: string, targetParentFolderId: string | null) => Promise<void>;
  isLoading: boolean;
  containerRef?: RefObject<HTMLDivElement>;
  editorTitleInputRef?: RefObject<HTMLInputElement>;
}

// Wrap component with forwardRef
export const Sidebar = forwardRef<SidebarHandle, SidebarProps>((
  {
    onXmtpConnect,
    onXmtpDisconnect,
    notebooks,
    selectedNotebookId,
    notes,
    folders,
    selectedNoteId,
    onSelectNotebook,
    onCreateNotebook,
    onSelectNote,
    onCreateNote,
    onDeleteNote,
    onCreateFolder,
    onDeleteFolder,
    onUpdateFolder,
    onMoveNoteToFolder,
    onMoveFolder,
    isLoading,
    containerRef,
    editorTitleInputRef
  }, ref) => {

  const [isCreatingNotebook, setIsCreatingNotebook] = useState(false);
  const [newNotebookName, setNewNotebookName] = useState('');
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderParentId, setNewFolderParentId] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
  const [draggedItemType, setDraggedItemType] = useState<'note' | 'folder' | null>(null);
  const [dragOverTargetId, setDragOverTargetId] = useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [folderNewName, setFolderNewName] = useState('');

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

  const handleCreateNotebookSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newNotebookName.trim()) return;
    try {
      await onCreateNotebook(newNotebookName.trim());
      setNewNotebookName('');
      setIsCreatingNotebook(false);
    } catch (error) {
      console.error('Failed to create notebook:', error);
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
  const getRootFolders = () => folders.filter(f => f.parentFolderId === null && f.notebookId === selectedNotebookId).sort((a,b) => a.name.localeCompare(b.name));
  const getChildFolders = (parentId: string) => folders.filter(f => f.parentFolderId === parentId).sort((a,b) => a.name.localeCompare(b.name));
  const getNotesInFolder = (folderId: string | null) => notes.filter(n => n.folderId === folderId && n.notebookId === selectedNotebookId).sort((a,b) => (a.title || '').localeCompare(b.title || ''));

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
        isCreatingNotebook ||
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
    isCreatingNotebook,
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

    const handleDragEnd = (e: React.DragEvent) => {
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
            <li key={`folder-${folder.id}`} className={`ml-${depth * 2} mb-px ${isBeingDragged ? 'opacity-40' : ''}`}>
                <div
                    className={`flex items-center group rounded-sm ${isDragOver ? 'drag-over' : ''} focus-within:bg-blue-100`}
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
                        className="p-1 mr-1 text-gray-500 hover:bg-gray-200 rounded-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
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
                                className="flex-1 folder-edit-input"
                                autoFocus
                                onBlur={handleRenameFolderSubmit} // Save on blur too
                                onKeyDown={(e) => {
                                    if (e.key === 'Escape') { e.stopPropagation(); setRenamingFolderId(null); itemRefs.current.get(`folder-${folder.id}`)?.focus();}
                                    if (e.key === 'Enter') { e.stopPropagation(); handleRenameFolderSubmit(e); }
                                }}
                            />
                         </form>
                     ) : (
                         <>
                             <div className="flex items-center flex-1 p-1 rounded-sm group-hover:bg-gray-100">
                                 <FolderIcon size={16} className="mr-1 text-gray-500" />
                                 <span className="text-sm truncate select-none">{folder.name}</span>
                             </div>
                              <button
                                  className="p-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 text-blue-500 hover:bg-gray-200 rounded-sm focus:outline-none focus:ring-1 focus:ring-blue-400 mr-1"
                                  onClick={(e) => {e.stopPropagation(); handleRenameFolderClick(folder);}}
                                  title="Rename folder"
                                  aria-label={`Rename folder ${folder.name}`}
                                  tabIndex={-1}
                              >
                                  <Edit2 size={14} />
                              </button>
                              <button
                                  className="p-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 text-red-500 hover:bg-red-100 rounded-sm focus:outline-none focus:ring-1 focus:ring-red-400"
                                  onClick={(e) => {e.stopPropagation(); onDeleteFolder(folder.id);}}
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
                className={`relative group ml-${depth * 2} ${isBeingDragged ? 'opacity-40' : ''}`}
                draggable
                onDragStart={(e) => handleDragStart(e, 'note', note.id)}
                onDragEnd={handleDragEnd} // Add drag end handler
             >
                <button
                    className={`w-full text-left px-3 py-1 my-px rounded-sm text-sm draggable-note focus:outline-none focus:bg-transparent focus:ring-1 focus:ring-blue-400 ${selectedNoteId === note.id ? 'bg-blue-100 font-medium' : 'hover:bg-gray-100'}`}
                    // Removed drag opacity from button, apply to li
                    onClick={() => onSelectNote(note)}
                    data-note-id={note.id}
                    ref={registerRef('note', note.id)}
                    tabIndex={-1}
                >
                     <span className="block truncate select-none">{note.title || 'Untitled'}</span>
                </button>
                 <button
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-sm opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-red-100 text-red-600 focus:outline-none focus:ring-1 focus:ring-red-400"
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

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="h-full flex flex-col border-r focus:outline-none"
    >
       {/* XMTP Connect Section */} 
        <div className="p-4 border-b">
            <XmtpConnect onConnect={onXmtpConnect} onDisconnect={onXmtpDisconnect} />
        </div>
        <div className="p-4 flex-col space-y-2 border-b">
            <div className="flex justify-between items-center">
                <h2 className="text-lg font-semibold">Notebooks</h2>
                <button
                    className="p-2 rounded-md hover:bg-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-400"
                    onClick={() => setIsCreatingNotebook(true)}
                    aria-label="Create new notebook"
                    tabIndex={-1}
                >
                    <Plus className="h-5 w-5" />
                </button>
            </div>
            {/* Notebook List */} 
             <ul className="space-y-1 mt-2">
              {notebooks.map((notebook) => (
                <li key={notebook.id}>
                  <button
                    className={`w-full flex items-center px-3 py-2 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-400 ${selectedNotebookId === notebook.id ? "bg-gray-200" : "hover:bg-gray-100"}`}
                    onClick={() => onSelectNotebook(notebook.id)}
                    tabIndex={-1}
                  >
                    <Book className="h-4 w-4 mr-2" />
                    <span className="truncate">{notebook.name}</span>
                  </button>
                </li>
              ))}
            </ul>
        </div>

      {/* Folders and Notes Section */} 
      <div className="flex-1 overflow-hidden flex flex-col">
          <div className="p-4 flex justify-between items-center border-b">
            <h2 className="text-lg font-semibold">Notes</h2>
             {/* ... Create Folder/Note buttons ... */}
              <div className="flex">
                 <button
                    className="p-2 rounded-md hover:bg-gray-100 disabled:opacity-50 mr-1 focus:outline-none focus:ring-1 focus:ring-blue-400"
                    onClick={() => { setIsCreatingFolder(true); setNewFolderParentId(null); }}
                    title="Create new folder"
                    disabled={!selectedNotebookId || isLoading}
                    aria-label="Create new root folder"
                    tabIndex={-1}
                 >
                    <FolderIcon className="h-5 w-5" />
                 </button>
                 <button
                    className="p-2 rounded-md hover:bg-gray-100 disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-blue-400"
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
                <div className="px-4 py-2 border-b">
                  <form onSubmit={handleCreateFolderSubmit} className="mt-2">
                    <input
                      type="text"
                      value={newFolderName}
                      onChange={(e) => setNewFolderName(e.target.value)}
                      placeholder="Folder name"
                      className="w-full p-2 border rounded-md text-sm"
                      autoFocus
                      onKeyDown={(e) => { if (e.key === 'Escape') setIsCreatingFolder(false); }}
                    />
                     <div className="flex justify-end mt-2 space-x-2">
                       <button
                         type="button"
                         onClick={() => setIsCreatingFolder(false)}
                         className="px-2 py-1 text-sm text-gray-600 hover:bg-gray-100 rounded-md"
                       >
                         Cancel
                       </button>
                       <button
                         type="submit"
                         className="px-2 py-1 text-sm bg-blue-500 text-white rounded-md hover:bg-blue-600"
                       >
                         Create
                       </button>
                     </div>
                  </form>
                </div>
           )}

          {/* Tree View Area */} 
          <div
            className="flex-1 overflow-auto p-2"
             onDragOver={(e) => handleDragOver(e, null)} // Allow dropping on root area
             onDragLeave={handleDragLeave}
             onDrop={(e) => handleDrop(e, null)}
          >
            {isLoading ? (
               <div className="flex items-center justify-center h-20 text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading...</div>
            ) : !selectedNotebookId ? (
               <p className="text-center text-gray-500 p-4">Select a notebook</p>
            ) : (folders.length === 0 && notes.filter(n => n.folderId === null && n.notebookId === selectedNotebookId).length === 0) ? (
               <p className="text-center text-gray-500 p-4">No notes or folders yet</p>
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
    </div>
  );
});
