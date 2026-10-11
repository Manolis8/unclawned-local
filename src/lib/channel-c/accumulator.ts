import { extractDomain } from './domain-classifier.js'
import { extractExtension, extractFolderName } from './file-classifier.js'
import type { DesktopScanResult } from './env-scanner.js'

// ─── ChannelCAccumulator ──────────────────────────────────────────────────────
//
// Lightweight state accumulator for one agent task execution.
// Tools call addDomain / addFileAccess as they run.
// At task completion, flush() fires the signal pipeline (fire-and-forget).

export class ChannelCAccumulator {
  private _domains: string[] = []
  private _fileExtensions: string[] = []
  private _folderNames: string[] = []
  private _desktopScan: DesktopScanResult | null = null

  addDomain(url: string): void {
    try {
      const domain = extractDomain(url)
      if (domain && !this._domains.includes(domain)) {
        this._domains.push(domain)
      }
    } catch { /* non-fatal */ }
  }

  addFileAccess(filePath: string): void {
    try {
      const ext = extractExtension(filePath)
      if (ext && !this._fileExtensions.includes(ext)) {
        this._fileExtensions.push(ext)
      }
      const folder = extractFolderName(filePath)
      if (folder && !this._folderNames.includes(folder)) {
        this._folderNames.push(folder)
      }
    } catch { /* non-fatal */ }
  }

  setDesktopScan(scan: DesktopScanResult): void {
    this._desktopScan = scan
  }

  hasData(): boolean {
    return this._domains.length > 0 || this._fileExtensions.length > 0 || this._desktopScan !== null
  }

  // Derives 'browser' | 'local' | 'hybrid' from what was observed
  deriveTaskType(): string {
    const hasDomains = this._domains.length > 0
    const hasFiles = this._fileExtensions.length > 0 || this._folderNames.length > 0
    if (hasDomains && hasFiles) return 'hybrid'
    if (hasDomains) return 'browser'
    return 'local'
  }

  flush(userId: string, sessionId: string | null, taskType: string): void {
    if (!this.hasData()) return

    const domains = [...this._domains]
    const fileExtensions = [...this._fileExtensions]
    const folderNames = [...this._folderNames]
    const desktopScan = this._desktopScan

    import('./extractor.js')
      .then(({ extractChannelCSignals }) =>
        extractChannelCSignals({ userId, sessionId, taskType, domainsVisited: domains, fileExtensions, folderNames, desktopScan })
      )
      .catch(err => console.error('[channel-c] flush error:', err))
  }

  reset(): void {
    this._domains = []
    this._fileExtensions = []
    this._folderNames = []
    this._desktopScan = null
  }
}
