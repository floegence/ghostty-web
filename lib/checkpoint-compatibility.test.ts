import { describe, expect, test } from 'bun:test';
import { Ghostty } from './ghostty';
import type { GhosttyCell } from './types';

interface CheckpointTerminal {
  readonly cols: number;
  readonly rows: number;
  captureCheckpoint(): { bytes: Uint8Array };
  restoreCheckpoint(bytes: Uint8Array): void;
  getStateDigest(): string;
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  update(): number;
  getViewport(): GhosttyCell[];
  getCursor(): { x: number; y: number; visible: boolean };
  getMode(mode: number, isAnsi?: boolean): boolean;
  isAlternateScreen(): boolean;
  getScrollbackLength(): number;
  isRowWrapped(row: number): boolean;
  getGraphemeString(row: number, col: number): string;
  getHyperlinkUri(row: number, col: number): string | null;
  free(): void;
}

const MODES = [
  [4, true],
  [1, false],
  [6, false],
  [7, false],
  [25, false],
  [1004, false],
  [1006, false],
  [2004, false],
  [2027, false],
] as const;

async function createTerminal(cols: number, rows: number): Promise<CheckpointTerminal> {
  const ghostty = await Ghostty.load();
  return ghostty.createTerminal(cols, rows, {
    scrollbackLimit: 2_000_000,
  }) as unknown as CheckpointTerminal;
}

function observableState(terminal: CheckpointTerminal): unknown {
  terminal.update();
  const cells = terminal.getViewport();
  const richCells = cells
    .map((cell, index) => ({ cell, index }))
    .filter(({ cell }) => cell.codepoint !== 0 || cell.flags !== 0 || cell.hyperlink_id !== 0)
    .map(({ cell, index }) => ({
      index,
      cell,
      grapheme:
        cell.grapheme_len > 0
          ? terminal.getGraphemeString(Math.floor(index / terminal.cols), index % terminal.cols)
          : '',
      hyperlink:
        cell.hyperlink_id > 0
          ? terminal.getHyperlinkUri(Math.floor(index / terminal.cols), index % terminal.cols)
          : null,
    }));
  return {
    digest: terminal.getStateDigest(),
    cursor: terminal.getCursor(),
    alternate: terminal.isAlternateScreen(),
    scrollbackLength: terminal.getScrollbackLength(),
    modes: MODES.map(([mode, ansi]) => [mode, ansi, terminal.getMode(mode, ansi)]),
    wrappedRows: Array.from({ length: terminal.rows }, (_, row) => terminal.isRowWrapped(row)),
    richCells,
  };
}

function cellAt(terminal: CheckpointTerminal, row: number, col: number): GhosttyCell {
  return terminal.getViewport()[row * terminal.cols + col];
}

const vectors = [
  {
    name: 'normal screen, scrollback, cursor editing, styles, and Unicode',
    cols: 80,
    rows: 24,
    before:
      Array.from({ length: 40 }, (_, row) => `history-${row}\r\n`).join('') +
      '\x1b[2;5r\x1b[?6h\x1b[3;7H\x1b[1;3;4;9;38;5;201;48;2;12;34;56m' +
      '界e\u0301👩‍💻\x1b[0m\x1b[4h\x1b[?25l',
    after: '\x1b[2K\x1b[5@continued\x1b[?25h',
    assertBefore(terminal: CheckpointTerminal) {
      expect(terminal.getScrollbackLength()).toBe(17);
      expect(terminal.getCursor()).toMatchObject({ x: 11, y: 3, visible: 0 });
      expect(terminal.getMode(4, true)).toBe(true);
      expect(terminal.getMode(6)).toBe(true);
      expect(terminal.getMode(25)).toBe(false);
      expect(cellAt(terminal, 3, 6)).toMatchObject({
        codepoint: '界'.codePointAt(0),
        width: 2,
        flags: 15,
        fg_r: 255,
        fg_g: 0,
        fg_b: 255,
        bg_r: 12,
        bg_g: 34,
        bg_b: 56,
      });
      expect(terminal.getGraphemeString(3, 8)).toBe('e\u0301');
      expect(terminal.getGraphemeString(3, 9)).toBe('👩‍💻');
    },
    assertAfter(terminal: CheckpointTerminal) {
      expect(terminal.getCursor()).toMatchObject({ x: 20, y: 3, visible: 1 });
      const continuation = terminal
        .getViewport()
        .slice(3 * terminal.cols + 11, 3 * terminal.cols + 20)
        .map((cell) => String.fromCodePoint(cell.codepoint))
        .join('');
      expect(continuation).toBe('continued');
    },
  },
  {
    name: 'alternate screen 47/1047/1049, saved cursor, modes, and OSC 8',
    cols: 80,
    rows: 24,
    before:
      'primary-state\x1b7\x1b[?1049h\x1b[2J\x1b[6;9H' +
      '\x1b]8;id=checkpoint;https://example.com/state\x07linked\x1b]8;;\x07' +
      '\x1b[?1004h\x1b[?1006h\x1b[?2004h',
    after: '\x1b[2;4Hdelta\x1b[?1049l\x1b8\x1b[?47h\x1b[?47l',
    assertBefore(terminal: CheckpointTerminal) {
      expect(terminal.isAlternateScreen()).toBe(true);
      expect(terminal.getCursor()).toMatchObject({ x: 14, y: 5 });
      expect(terminal.getMode(1004)).toBe(true);
      expect(terminal.getMode(1006)).toBe(true);
      expect(terminal.getMode(2004)).toBe(true);
      expect(terminal.getHyperlinkUri(5, 8)).toBe('https://example.com/state');
      expect(cellAt(terminal, 5, 8)).toMatchObject({
        codepoint: 'l'.codePointAt(0),
        hyperlink_id: 1,
      });
    },
    assertAfter(terminal: CheckpointTerminal) {
      expect(terminal.isAlternateScreen()).toBe(false);
      expect(terminal.getCursor()).toMatchObject({ x: 13, y: 0 });
      const primary = terminal
        .getViewport()
        .slice(0, 13)
        .map((cell) => String.fromCodePoint(cell.codepoint))
        .join('');
      expect(primary).toBe('primary-state');
    },
  },
  {
    name: 'tabs, G0 charset, margins, pending wrap, and resize boundaries',
    cols: 80,
    rows: 24,
    before:
      '\x1b[3g\x1b[5G\x1bH\x1b[13G\x1bH\x1b(0lqqk\x1b(B\r\n' +
      '\x1b[?69h\x1b[3;20s\x1b[2;20r\x1b[20G' +
      'X'.repeat(80),
    resize: [140, 52, 88, 24, 132, 46] as const,
    after: '\tpost-resize\x1b[?69l\x1b[r',
    assertBefore(terminal: CheckpointTerminal) {
      expect({ cols: terminal.cols, rows: terminal.rows }).toEqual({ cols: 132, rows: 46 });
      expect(terminal.getCursor()).toMatchObject({ x: 9, y: 5 });
      expect(terminal.getMode(69)).toBe(true);
      expect([12, 13, 14, 15].map((col) => cellAt(terminal, 0, col).codepoint)).toEqual([
        0x250c, 0x2500, 0x2500, 0x2510,
      ]);
    },
    assertAfter(terminal: CheckpointTerminal) {
      expect(terminal.getMode(69)).toBe(false);
      expect({ cols: terminal.cols, rows: terminal.rows }).toEqual({ cols: 132, rows: 46 });
    },
  },
] as const;

describe('checkpoint compatibility vectors', () => {
  for (const vector of vectors) {
    test(`${vector.name} round-trips and continues identically`, async () => {
      const source = await createTerminal(vector.cols, vector.rows);
      const restored = await createTerminal(vector.cols, vector.rows);
      try {
        source.write(vector.before);
        if ('resize' in vector) {
          for (let i = 0; i < vector.resize.length; i += 2) {
            source.resize(vector.resize[i], vector.resize[i + 1]);
            restored.resize(vector.resize[i], vector.resize[i + 1]);
          }
        }

        vector.assertBefore(source);

        const checkpoint = source.captureCheckpoint();
        restored.restoreCheckpoint(checkpoint.bytes);
        expect(observableState(restored)).toEqual(observableState(source));
        vector.assertBefore(restored);

        source.write(vector.after);
        restored.write(vector.after);
        expect(observableState(restored)).toEqual(observableState(source));
        vector.assertAfter(source);
        vector.assertAfter(restored);
      } finally {
        source.free();
        restored.free();
      }
    });
  }
});
