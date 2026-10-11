// error-pattern-detector.ts
// Sliding-window detector for repeated (toolName, errorFingerprint) pairs.
// Lives outside the messages array — zero tokens, zero LLM cost.

export class ErrorPatternDetector {
  private window: Array<{ tool: string; fp: string }> = []
  private readonly WINDOW_SIZE = 5
  private readonly THRESHOLD = 3

  // Call after every tool dispatch. Returns true when the same (tool, error) pair
  // has appeared THRESHOLD times in the sliding window — meaning the agent is stuck.
  // Clears the window on any successful call so recovery resets state cleanly.
  record(toolName: string, result: string, isError: boolean): boolean {
    if (!isError) {
      this.window = []
      return false
    }
    const fp = this.fingerprint(result)
    // Shift window: drop oldest if at capacity, append new entry
    this.window = [...this.window.slice(-(this.WINDOW_SIZE - 1)), { tool: toolName, fp }]
    const count = this.window.filter(e => e.tool === toolName && e.fp === fp).length
    return count >= this.THRESHOLD
  }

  // Strips variable parts (hex IDs, UUIDs, URLs) from error text so that semantically
  // identical errors from different pages are treated as the same fingerprint.
  private fingerprint(error: string): string {
    return error
      .slice(0, 80)
      .replace(/[0-9a-f-]{8,}/gi, 'X')
      .replace(/https?:\/\/\S+/g, 'URL')
  }

  getCorrectionFor(toolName: string): string {
    const corrections: Record<string, string> = {
      browser_read:     'Call browser_navigate with the target URL first to open a page, then retry browser_read.',
      browser_snapshot: 'Call browser_navigate with the target URL first to open a page, then retry browser_snapshot.',
      browser_click:    'Call browser_snapshot to see the current page state, then identify the correct element ref before clicking.',
      web_search:       'Rephrase your search query — the previous query returned no results. Try different keywords or a broader phrasing.',
    }
    return corrections[toolName] ?? 'Try a completely different approach for this step — the current method is not working.'
  }
}
