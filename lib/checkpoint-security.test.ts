import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Ghostty } from './ghostty';

interface CheckpointTerminal {
  captureCheckpoint(): { bytes: Uint8Array };
  restoreCheckpoint(bytes: Uint8Array): void;
  validateCheckpoint(bytes: Uint8Array): unknown;
  getStateDigest(): string;
  write(data: string | Uint8Array): void;
  free(): void;
}

const HEADER_SIZE = 93;
const CHECKSUM_OFFSET = 61;

async function createTerminal(cols: number, rows: number): Promise<CheckpointTerminal> {
  const ghostty = await Ghostty.load();
  return ghostty.createTerminal(cols, rows, {
    scrollbackLimit: 2_000_000,
  }) as unknown as CheckpointTerminal;
}

function rewritePayloadChecksum(bytes: Uint8Array): void {
  const checksum = createHash('sha256').update(bytes.subarray(HEADER_SIZE)).digest();
  bytes.set(checksum, CHECKSUM_OFFSET);
}

describe('checkpoint security and resource budgets', () => {
  test('handles deterministic malformed payload fuzz without trapping or corrupting live state', async () => {
    const terminal = await createTerminal(40, 12);
    try {
      terminal.write(
        '\x1b[?1049h\x1b[2J\x1b[4;7H\x1b[1;38;2;12;34;56m' +
          'fuzz-seed-界-e\u0301-👩‍💻\x1b]8;;https://example.com/checkpoint\x07link\x1b]8;;\x07'
      );
      const checkpoint = terminal.captureCheckpoint().bytes;
      const digest = terminal.getStateDigest();

      let stateInvariantOrValid = 0;
      for (let index = HEADER_SIZE; index < checkpoint.length; index += 97) {
        const mutated = checkpoint.slice();
        mutated[index] ^= ((index * 31) % 251) + 1;
        rewritePayloadChecksum(mutated);
        try {
          terminal.validateCheckpoint(mutated);
          stateInvariantOrValid += 1;
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
        }
        expect(terminal.getStateDigest()).toBe(digest);
      }

      expect(stateInvariantOrValid).toBeLessThan(checkpoint.length / 97);
    } finally {
      terminal.free();
    }
  });

  test('stays within capture and restore budgets across viewport and scrollback sizes', async () => {
    const cases = [
      { cols: 80, rows: 24, historyRows: 0, budgetMs: 250 },
      { cols: 132, rows: 46, historyRows: 0, budgetMs: 500 },
      { cols: 500, rows: 200, historyRows: 0, budgetMs: 2_000 },
      { cols: 132, rows: 46, historyRows: 2_000, budgetMs: 2_000 },
    ] as const;

    for (const fixture of cases) {
      const source = await createTerminal(fixture.cols, fixture.rows);
      const target = await createTerminal(fixture.cols, fixture.rows);
      try {
        if (fixture.historyRows > 0) {
          source.write(
            Array.from({ length: fixture.historyRows }, (_, row) => `history-${row}\r\n`).join('')
          );
        }
        source.write('\x1b[1;38;5;201mcheckpoint-budget-界-e\u0301\x1b[0m');

        const captureStarted = performance.now();
        const checkpoint = source.captureCheckpoint();
        const captureMs = performance.now() - captureStarted;
        const restoreStarted = performance.now();
        target.restoreCheckpoint(checkpoint.bytes);
        const restoreMs = performance.now() - restoreStarted;

        expect(checkpoint.bytes.length).toBeLessThan(64 * 1024 * 1024);
        expect(captureMs).toBeLessThan(fixture.budgetMs);
        expect(restoreMs).toBeLessThan(fixture.budgetMs);
        expect(target.getStateDigest()).toBe(source.getStateDigest());
      } finally {
        source.free();
        target.free();
      }
    }
  });

  test('does not grow WASM memory monotonically across 10,000 capture and restore cycles', async () => {
    const terminal = await createTerminal(8, 4);
    try {
      terminal.write('\x1b[1;32mcycle\x1b[0m');
      const checkpoint = terminal.captureCheckpoint().bytes;

      for (let index = 0; index < 50; index++) {
        terminal.captureCheckpoint();
        terminal.restoreCheckpoint(checkpoint);
      }
      const memory = (terminal as unknown as { memory: WebAssembly.Memory }).memory;
      const warmedBytes = memory.buffer.byteLength;

      for (let index = 0; index < 10_000; index++) {
        terminal.captureCheckpoint();
        terminal.restoreCheckpoint(checkpoint);
      }

      expect(memory.buffer.byteLength).toBe(warmedBytes);
    } finally {
      terminal.free();
    }
  });
});
