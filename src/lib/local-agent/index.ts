// Read tools (Part 1)
export { readFile, listDirectory, findFile, searchInFile, getFileInfo, formatReadFileResult, formatListDirectoryResult, formatFindFileResult, formatSearchResult, formatFileInfo } from './read-tools.js'
export { localReadToolDefinitions } from './tool-definitions.js'
export type { SearchOptions, FileInfo } from './read-tools.js'
export type { SearchResult, SearchFileResult, SearchLineGroup } from './types.js'

// Move/copy tools (Phase 6)
export { previewMoveFile, executeMoveFile, previewCopyFile, executeCopyFile, formatMoveFileResult, formatCopyFileResult, moveToolDefinitions } from './move-tools.js'
export type { MoveFilePreview, MoveFileResult, CopyFilePreview, CopyFileResult } from './move-tools.js'

// Write tools (Part 2 — Phase 8: atomic writes + encoding preservation)
export { previewWriteFile, executeWriteFile, formatWriteFileResult, executeCreateDirectory, formatCreateDirectoryResult, writeToolDefinitions } from './write-tools.js'
export type { WriteMode, WriteFileResult, WriteFilePreview, CreateDirectoryResult } from './write-tools.js'

// Session journal (Phase 9 — undo_last_change + show_history)
export { takeSnapshot, addJournalEntry, undoLastChange, getHistory, formatHistory, formatUndoResult, markLastDeleteRolledBack, journalToolDefinitions } from './session-journal.js'
export type { Snapshot, JournalEntry, UndoResult } from './session-journal.js'

// Edit tools (Phase 3 — str_replace)
export { previewEditFile, executeEditFile, formatEditFileResult, editToolDefinitions } from './edit-tools.js'
export type { EditFilePreview, EditFileResult } from './edit-tools.js'

// Delete tools (Phase 5 — recycle bin)
export { previewDeleteFile, previewDeleteDirectory, deleteFile, deleteDirectory, restoreLastDelete, formatDeleteFileResult, formatDeleteDirectoryResult, formatRestoreResult, deleteToolDefinitions } from './delete-tools.js'
export type { DeleteFilePreview, DeleteDirectoryPreview, DeleteFileResult, DeleteDirectoryResult, RestoreResult } from './delete-tools.js'

// Command tools (Part 3)
export { previewRunCommand, executeRunCommand, formatRunCommandResult, executeRunCommandBackground, formatBackgroundCommandResult, commandToolDefinitions } from './command-tools.js'
export type { RunCommandPreview, RunCommandResult, BackgroundCommandResult } from './command-tools.js'

// App + clipboard tools (Part 4)
export { buildOpenAppCommand, executeOpenApp, readClipboard, writeClipboard, appToolDefinitions } from './app-tools.js'
export type { OpenAppResult } from './app-tools.js'

// Platform profile (Phase 1)
export { getPlatformProfile, getPlatformSummary, resetPlatformProfile } from './platform-profile.js'
export type { PlatformProfile, OsFamily, ShellName, ShellInfo, RuntimeInfo, RuntimeKey } from './platform-profile.js'

// OS special-folder resolution (Desktop, Documents, Downloads, etc.)
export { getSpecialFolders, resolveSpecialFolderAlias, resetSpecialFolders } from './special-folders.js'
export type { SpecialFolders } from './special-folders.js'

// CLAUDE.md auto-injection
export { loadClaudeMdFiles } from './claude-md.js'

// Todo tools (TodoRead / TodoWrite)
export { readTodos, writeTodos, clearTodos, formatTodos, todoToolDefinitions } from './todo-tools.js'
export type { TodoItem } from './todo-tools.js'

// Chrome browser data tools (bookmarks, history, cookies)
export { getChromeBookmarks, getChromeHistory, formatBookmarks, formatHistory as formatChromeHistory, chromeToolDefinitions } from './chrome-tools.js'
export type { Bookmark, HistoryEntry } from './chrome-tools.js'

// Security + types
export { validatePath, isBinaryFile, getAllowedDirs, formatBytes } from './security.js'
export type { ReadFileResult, ListDirectoryResult, DirEntry, FindFileResult, FileMatch } from './types.js'
