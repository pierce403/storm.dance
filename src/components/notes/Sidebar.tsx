import { useState, useEffect } from 'react';
import { Plus, Trash2, Book, Loader2, ChevronRight, ChevronDown, Folder as FolderIcon, Edit2 } from 'lucide-react';
import { Note, Notebook, Folder, dbService } from '../../lib/db';
import { XmtpConnect } from '../xmtp/XmtpConnect';
import { Client } from '@xmtp/xmtp-js';

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
  onCreateNote: () => void;
  onDeleteNote: (noteId: string) => void;
  onCreateFolder: (name: string, parentFolderId: string | null) => Promise<void>;
  onDeleteFolder: (folderId: string) => Promise<void>;
  onUpdateFolder: (folderId: string, updates: Partial<Omit<Folder, 'id' | 'createdAt' | 'updatedAt' | 'notebookId'>>) => Promise<void>;
  onMoveNoteToFolder: (noteId: string, folderId: string | null) => Promise<void>;
  isLoading: boolean;
}

export function Sidebar({
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
  isLoading,
}: SidebarProps) {

  const [isCreatingNotebook, setIsCreatingNotebook] = useState(false);
  const [newNotebookName, setNewNotebookName] = useState('');
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderParentId, setNewFolderParentId] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [draggedNoteId, setDraggedNoteId] = useState<string | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [folderNewName, setFolderNewName] = useState('');

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

  const handleRenameFolderSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renamingFolderId || !folderNewName.trim()) return;
    
    try {
      await onUpdateFolder(renamingFolderId, { name: folderNewName.trim() });
      
      // Reset renaming state
      setRenamingFolderId(null);
      setFolderNewName('');
    } catch (error) {
      console.error('Failed to rename folder:', error);
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

  // Function to get root level folders
  const getRootFolders = () => {
    return folders.filter(folder => folder.parentFolderId === null && folder.notebookId === selectedNotebookId);
  };

  // Function to get child folders
  const getChildFolders = (parentId: string) => {
    return folders.filter(folder => folder.parentFolderId === parentId);
  };

  // Function to get notes in a folder
  const getNotesInFolder = (folderId: string | null) => {
    return notes.filter(note => note.folderId === folderId);
  };

  // Drag and drop handlers
  const handleDragStart = (e: React.DragEvent, noteId: string) => {
    setDraggedNoteId(noteId);
    e.dataTransfer.setData('text/plain', noteId);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, folderId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Only handle if we're dragging a note
    if (draggedNoteId) {
      setDragOverFolderId(folderId);
      e.dataTransfer.dropEffect = 'move';
    }
  };

  const handleDragLeave = () => {
    setDragOverFolderId(null);
  };

  const handleDrop = async (e: React.DragEvent, folderId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (!draggedNoteId) return;
    
    // Get the note that's being dragged
    const draggedNote = notes.find(note => note.id === draggedNoteId);
    if (!draggedNote) return;
    
    // Do nothing if dropping into the same folder
    if (draggedNote.folderId === folderId) {
      setDraggedNoteId(null);
      setDragOverFolderId(null);
      return;
    }
    
    // Update the note's folder
    try {
      await onMoveNoteToFolder(draggedNoteId, folderId);
      
      // Expand target folder if it's not already expanded
      if (folderId) {
        setExpandedFolders(prev => {
          const newSet = new Set(prev);
          newSet.add(folderId);
          return newSet;
        });
      }
    } catch (error) {
      console.error('Failed to move note:', error);
    }
    
    setDraggedNoteId(null);
    setDragOverFolderId(null);
  };

  // Recursive component to render folders and their children
  const renderFolderTree = (parentFolderId: string | null) => {
    const folderList = parentFolderId === null 
      ? getRootFolders() 
      : getChildFolders(parentFolderId);
    
    if (folderList.length === 0 && parentFolderId === null) {
      // No root folders
      return null;
    }
    
    return (
      <ul className="pl-2">
        {folderList.map(folder => {
          const isExpanded = expandedFolders.has(folder.id);
          const childFolders = getChildFolders(folder.id);
          const folderNotes = getNotesInFolder(folder.id);
          const isDragOver = dragOverFolderId === folder.id;
          const isRenaming = renamingFolderId === folder.id;
          
          return (
            <li key={folder.id} className="mb-1">
              <div 
                className={`flex items-center group ${isDragOver ? 'drag-over' : ''}`}
                onDragOver={(e) => handleDragOver(e, folder.id)}
                onDragLeave={handleDragLeave}
                onDrop={(e) => handleDrop(e, folder.id)}
              >
                <button 
                  onClick={() => toggleFolder(folder.id)}
                  className="p-1 mr-1 text-gray-500"
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
                      onBlur={() => setRenamingFolderId(null)}
                    />
                    <button type="submit" className="ml-1 p-1 text-blue-500">
                      Save
                    </button>
                  </form>
                ) : (
                  <>
                    <div className="flex items-center flex-1 p-1 rounded-md group-hover:bg-gray-100">
                      <FolderIcon size={16} className="mr-1 text-gray-500" />
                      <span className="text-sm truncate">{folder.name}</span>
                    </div>
                    <button
                      className="p-1 opacity-0 group-hover:opacity-100 text-blue-500 mr-1"
                      onClick={() => handleRenameFolderClick(folder)}
                      title="Rename folder"
                    >
                      <Edit2 size={14} />
                    </button>
                    <button
                      className="p-1 opacity-0 group-hover:opacity-100 text-red-500"
                      onClick={() => onDeleteFolder(folder.id)}
                      title="Delete folder"
                    >
                      <Trash2 size={14} />
                    </button>
                  </>
                )}
              </div>
              
              {isExpanded && (
                <div className="ml-4">
                  {/* Child folders */}
                  {renderFolderTree(folder.id)}
                  
                  {/* Notes in this folder */}
                  <ul className="space-y-1 my-1">
                    {folderNotes.map(note => (
                      <li 
                        key={note.id} 
                        className="relative group"
                        draggable
                        onDragStart={(e) => handleDragStart(e, note.id)}
                      >
                        <button
                          className={`w-full text-left px-3 py-1 rounded-md text-sm draggable-note ${
                            selectedNoteId === note.id ? "bg-gray-200" : "hover:bg-gray-100"
                          } ${draggedNoteId === note.id ? 'opacity-50' : ''}`}
                          onClick={() => onSelectNote(note)}
                        >
                          <span className="block truncate">{note.title || 'Untitled'}</span>
                        </button>
                        <button
                          className="absolute right-2 top-1 p-1 rounded-md opacity-0 group-hover:opacity-100 hover:bg-red-100 text-red-600"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteNote(note.id);
                          }}
                          title="Delete note"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <div className="h-full flex flex-col border-r">
      <div className="p-4">
        <XmtpConnect 
          onConnect={onXmtpConnect} 
          onDisconnect={onXmtpDisconnect} 
        />
      </div>
      
      <div className="border-t"></div>
      
      <div className="p-4 flex-col space-y-2">
        <div className="flex justify-between items-center">
          <h2 className="text-lg font-semibold">Notebooks</h2>
          <button
            className="p-2 rounded-md hover:bg-gray-100"
            onClick={() => setIsCreatingNotebook(true)}
          >
            <Plus className="h-5 w-5" />
          </button>
        </div>
        
        {isCreatingNotebook && (
          <form onSubmit={handleCreateNotebookSubmit} className="mt-2">
            <input
              type="text"
              value={newNotebookName}
              onChange={(e) => setNewNotebookName(e.target.value)}
              placeholder="Notebook name"
              className="w-full p-2 border rounded-md text-sm"
              autoFocus
            />
            <div className="flex justify-end mt-2 space-x-2">
              <button
                type="button"
                onClick={() => setIsCreatingNotebook(false)}
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
        )}
        
        <ul className="space-y-1 mt-2">
          {notebooks.map((notebook) => (
            <li key={notebook.id}>
              <button
                className={`w-full flex items-center px-3 py-2 rounded-md text-sm ${
                  selectedNotebookId === notebook.id
                    ? "bg-gray-200"
                    : "hover:bg-gray-100"
                }`}
                onClick={() => onSelectNotebook(notebook.id)}
              >
                <Book className="h-4 w-4 mr-2" />
                <span className="truncate">{notebook.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      
      <div className="flex-1 overflow-hidden flex flex-col">
          <div className="p-4 flex justify-between items-center">
            <h2 className="text-lg font-semibold">Notes</h2>
            <div className="flex">
              <button
                className="p-2 rounded-md hover:bg-gray-100 disabled:opacity-50 mr-1"
                onClick={() => {
                  setIsCreatingFolder(true);
                  setNewFolderParentId(null);
                }}
                title="Create new folder"
                disabled={!selectedNotebookId || isLoading}
              >
                <FolderIcon className="h-5 w-5" />
              </button>
              <button
                className="p-2 rounded-md hover:bg-gray-100 disabled:opacity-50"
                onClick={onCreateNote}
                title="Create new note"
                disabled={!selectedNotebookId || isLoading}
              >
                <Plus className="h-5 w-5" />
              </button>
            </div>
          </div>
          
          {isCreatingFolder && (
            <div className="px-4 pb-2">
              <form onSubmit={handleCreateFolderSubmit} className="mt-2">
                <input
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  placeholder="Folder name"
                  className="w-full p-2 border rounded-md text-sm"
                  autoFocus
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
          
          <div className="border-t"></div>
          <div className="flex-1 overflow-auto">
            <div className="p-2">
              {isLoading ? (
                <div className="flex items-center justify-center h-20 text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading Notes...
                </div>
              ) : !selectedNotebookId ? (
                <p className="text-center text-gray-500 p-4">Select a notebook</p>
              ) : (
                <div>
                  {/* Folder structure */}
                  {renderFolderTree(null)}
                  
                  {/* Root level notes (notes without folders) */}
                  <div 
                    className={`mt-2 p-1 rounded-md ${dragOverFolderId === null ? 'drag-over' : ''}`}
                    onDragOver={(e) => handleDragOver(e, null)}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, null)}
                  >
                    <div className="text-sm font-medium text-gray-500 py-1">Unfiled Notes</div>
                    <ul className="space-y-1">
                      {getNotesInFolder(null).map((note) => (
                        <li 
                          key={note.id} 
                          className="relative group"
                          draggable
                          onDragStart={(e) => handleDragStart(e, note.id)}
                        >
                          <button
                            className={`w-full text-left px-3 py-2 rounded-md text-sm draggable-note ${
                              selectedNoteId === note.id ? "bg-gray-200" : "hover:bg-gray-100"
                            } ${draggedNoteId === note.id ? 'opacity-50' : ''}`}
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
                  </div>
                </div>
              )}
            </div>
          </div>
      </div>
    </div>
  );
}
