export interface ReadFileResult {
  content: string
  totalLines: number
  wasTruncated: boolean
  resolvedPath: string
  startLine: number
  endLine: number
}

export interface DirEntry {
  name: string
  type: 'file' | 'dir'
  size: number
  sizeLabel: string
  modifiedAt: string
  extension: string | null
  relativePath: string
}

export interface ListDirectoryResult {
  entries: DirEntry[]
  resolvedPath: string
  totalEntries: number
  wasCapped: boolean
}

export interface FileMatch {
  path: string
  name: string
  size: number
  sizeLabel: string
  modifiedAt: string
}

export interface FindFileResult {
  matches: FileMatch[]
  searchDir: string
  pattern: string
  totalFound: number
}

// ─── search_in_file types ─────────────────────────────────────────────────────

export interface SearchLineGroup {
  startLine: number        // 1-indexed, first line shown in this block
  lines: Array<{
    lineNumber: number
    content: string
    isMatch: boolean       // true = this line matched the pattern
  }>
}

export interface SearchFileResult {
  filePath: string
  groups: SearchLineGroup[]
  matchCount: number       // matches in this file
  wasCapped: boolean
}

export interface SearchResult {
  pattern: string
  isRegex: boolean
  fileResults: SearchFileResult[]
  totalMatchCount: number
  totalFileCount: number
  wasCapped: boolean       // true if max_results hit across all files
  outputMode?: 'content' | 'files_with_matches' | 'count'
}
