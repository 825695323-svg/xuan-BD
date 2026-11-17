/** Numeric progress from the pinned whisper.cpp v1.9.1 stderr callback, not transcript or task completion. */
export function createWhisperProgressParser(): {
  push(stream: 'stdout' | 'stderr', chunk: Buffer): number[];
} {
  const maxLineBytes = 128;
  let pending: number[] = [], dropping = false, highest = 0;
  return {
    push(stream, chunk) {
      if (stream !== 'stderr') return [];
      const progress: number[] = [];
      for (const byte of chunk) {
        if (byte === 10) {
          if (!dropping) {
            // Only a terminal CR forms CRLF; embedded CR, ANSI escapes and arbitrary prefixes remain invalid.
            if (pending.at(-1) === 13) pending.pop();
            const line = Buffer.from(pending).toString('latin1');
            const match = /^whisper_print_progress_callback: progress = ( {2}[1-9]| [1-9][0-9]|100)%$/u.exec(line);
            if (match) {
              const value = Number(match[1]);
              if (value > highest) { highest = value; progress.push(value); }
            }
          }
          pending = []; dropping = false;
        } else if (!dropping) {
          if (pending.length === maxLineBytes) { pending = []; dropping = true; }
          else pending.push(byte);
        }
      }
      return progress;
    },
  };
}
