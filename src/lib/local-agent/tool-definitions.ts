// OpenAI tool definitions for the local PC read tools (Part 1)
// Added to the browserTools array in agent-extension.ts

export const localReadToolDefinitions = [
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: [
        'Read a file from the user\'s local computer and return its text content.',
        'Output includes line numbers prefixed to every line (format: "N\\tcontent") — use these for edit_file old_str targeting.',
        'Use this when the task involves local documents, CSV files, notes, code, or any file on disk.',
        'Do NOT use this for web content — use browser tools for anything on a website.',
        'If you don\'t know the exact path, call find_file first to locate it.',
        'For large files: read the first chunk to understand structure, then read specific sections with start_line/end_line.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the file. Use find_file first if you don\'t know the exact path.',
          },
          start_line: {
            type: 'number',
            description: 'Line number to start reading from (1-indexed, default: 1). Use for reading specific sections of large files.',
          },
          end_line: {
            type: 'number',
            description: 'Line number to stop reading at (inclusive, default: up to 200 lines from start_line).',
          },
        },
        required: ['path'],
      },
    },
  },

  {
    type: 'function' as const,
    function: {
      name: 'list_directory',
      description: [
        'List files and folders in a directory on the user\'s computer.',
        'Use this to explore the file system when you need to find files or understand folder structure.',
        'Returns file names, sizes, and modification dates.',
        'Use find_file instead when you\'re searching for a specific file by name pattern.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the directory to list.',
          },
          depth: {
            type: 'number',
            description: 'How many folder levels deep to show (1–3, default: 1). Use 1 to see just the top level.',
          },
          filter: {
            type: 'string',
            description: 'Optional filename filter using * wildcard. Examples: "*.csv", "report*", "*.txt". Leave empty to show all files.',
          },
        },
        required: ['path'],
      },
    },
  },

  {
    type: 'function' as const,
    function: {
      name: 'search_in_file',
      description: [
        'Search for a pattern inside a file or across all files in a directory.',
        'Returns matching lines with surrounding context and 1-indexed line numbers.',
        'Use this before edit_file to find the exact text at the right line number.',
        'Safer and faster than run_command + grep — works identically on all platforms.',
        'Use is_regex: true for regex patterns (e.g. function\\s+\\w+ to find all functions).',
        'Use output_mode: "files_with_matches" to survey which files contain the pattern without reading them all.',
        'Use output_mode: "count" to see how many matches per file.',
        'Use multiline: true for patterns that span multiple lines (requires is_regex: true).',
        'Use file_extensions to limit directory search (e.g. ["ts","js"] for TypeScript projects).',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to a file or directory to search.',
          },
          pattern: {
            type: 'string',
            description: 'Text to search for. Plain string by default (case-insensitive). Set is_regex: true for regex.',
          },
          context_lines: {
            type: 'number',
            description: 'Lines of context to show before and after each match (default: 2, max: 5).',
          },
          is_regex: {
            type: 'boolean',
            description: 'Treat pattern as a regular expression. Default: false.',
          },
          case_sensitive: {
            type: 'boolean',
            description: 'Case-sensitive matching. Default: false (case-insensitive). Set true when searching for identifiers like MyClass or MY_CONSTANT.',
          },
          output_mode: {
            type: 'string',
            enum: ['content', 'files_with_matches', 'count'],
            description: 'content (default) = show matching lines with context. files_with_matches = only file paths. count = match count per file.',
          },
          multiline: {
            type: 'boolean',
            description: 'Allow regex to span multiple lines (requires is_regex: true). Enables dotAll mode so . matches newlines.',
          },
          max_results: {
            type: 'number',
            description: 'Max total matches to return (default: 50).',
          },
          file_extensions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Only search files with these extensions when path is a directory. Example: ["ts","js","py"]. Omit to search all text files.',
          },
        },
        required: ['path', 'pattern'],
      },
    },
  },

  {
    type: 'function' as const,
    function: {
      name: 'get_file_info',
      description: [
        'Get metadata about a file or directory without reading its content.',
        'Returns: size, line count, encoding (UTF-8/UTF-16/binary), line endings (LF/CRLF), created/modified dates, and permissions.',
        'Call this BEFORE read_file on large files to check size first.',
        'Call this BEFORE edit_file to check encoding (UTF-16 files need special handling).',
        'Call this BEFORE write_file to match the existing encoding of a file you are overwriting.',
        'Also useful after find_file returns multiple matches — compare dates and sizes to pick the right one.',
        'This is a read-only operation and runs automatically without confirmation.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the file or directory.',
          },
        },
        required: ['path'],
      },
    },
  },

  {
    type: 'function' as const,
    function: {
      name: 'find_file',
      description: [
        'Search for files by name or path pattern across the user\'s home directory.',
        'Supports full glob syntax: * (any chars in filename), ** (any depth of directories), ? (single char), {a,b} (alternatives).',
        'Simple patterns like "*.ts" match on filename only. Path patterns like "src/**/*.ts" match the full relative path.',
        'Use this when the user mentions "my file", "that document", or any file without giving an exact path.',
        'Returns matching files sorted by most recently modified.',
        'Always call this before read_file when you don\'t know the exact file location.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern. Simple: "*.csv", "report*", "*.txt". Path-based: "src/**/*.ts", "**/*.test.js", "lib/{utils,helpers}.ts".',
          },
          search_dir: {
            type: 'string',
            description: 'Absolute path of directory to search within (default: user\'s home directory). Use to narrow search to a specific folder.',
          },
        },
        required: ['pattern'],
      },
    },
  },
]
