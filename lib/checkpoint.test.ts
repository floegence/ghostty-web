import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Ghostty } from './ghostty';
import { DirtyState, type GhosttyCell } from './types';

interface CheckpointCoordinates {
  historySequence: bigint;
  geometryGeneration: bigint;
  parserEpoch: bigint;
}

interface CheckpointMetadata {
  formatVersion: number;
  cols: number;
  rows: number;
  uncompressedLength: number;
  checksum: string;
  historySequence: bigint;
  geometryGeneration: bigint;
  parserEpoch: bigint;
}

interface CapturedCheckpoint {
  bytes: Uint8Array;
  metadata: CheckpointMetadata;
}

interface CheckpointTerminal {
  captureCheckpoint(coordinates?: CheckpointCoordinates): CapturedCheckpoint;
  restoreCheckpoint(bytes: Uint8Array, expected?: CheckpointCoordinates): void;
  validateCheckpoint(bytes: Uint8Array): CheckpointMetadata;
  getCheckpointFormatVersion(): number;
  getStateDigest(): string;
  write(data: string | Uint8Array): void;
  update(): DirtyState;
  markClean(): void;
  getViewport(): GhosttyCell[];
  getCursor(): { x: number; y: number; visible: boolean };
  free(): void;
}

const CHECKPOINT_MAGIC = 'FLOE-GHOSTTY-CKPT';
const CHECKPOINT_HEADER_SIZE = 93;
const CHECKSUM_OFFSET = CHECKPOINT_MAGIC.length + 44;

function rewritePayloadChecksum(bytes: Uint8Array): void {
  const checksum = createHash('sha256').update(bytes.subarray(CHECKPOINT_HEADER_SIZE)).digest();
  bytes.set(checksum, CHECKSUM_OFFSET);
}

async function createCheckpointTerminal(cols = 80, rows = 24): Promise<CheckpointTerminal> {
  const ghostty = await Ghostty.load();
  return ghostty.createTerminal(cols, rows) as unknown as CheckpointTerminal;
}

describe('checkpoint ABI v1', () => {
  test('exports version, capture, validate, restore, and digest operations', async () => {
    const publicApi = await import('./index');
    expect(publicApi.CheckpointResult.OK).toBe(0);
    const terminal = await createCheckpointTerminal();
    try {
      expect(typeof terminal.getCheckpointFormatVersion).toBe('function');
      expect(typeof terminal.captureCheckpoint).toBe('function');
      expect(typeof terminal.validateCheckpoint).toBe('function');
      expect(typeof terminal.restoreCheckpoint).toBe('function');
      expect(typeof terminal.getStateDigest).toBe('function');
      expect(terminal.getCheckpointFormatVersion()).toBe(1);
    } finally {
      terminal.free();
    }
  });

  test('capture returns owned bytes and stable metadata across WASM memory growth', async () => {
    const terminal = await createCheckpointTerminal(132, 46);
    try {
      terminal.write('\x1b[?1049h\x1b[38;2;12;34;56mcheckpoint-owned\r\n');
      const captured = terminal.captureCheckpoint();
      const preserved = captured.bytes.slice();

      terminal.write('x'.repeat(4 * 1024 * 1024));

      expect(captured.bytes).toEqual(preserved);
      expect(captured.metadata).toMatchObject({ formatVersion: 1, cols: 132, rows: 46 });
      expect(captured.metadata.uncompressedLength).toBeGreaterThan(0);
      expect(captured.metadata.checksum).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      terminal.free();
    }
  });

  test('binds history, geometry, and parser coordinates into validation and restore', async () => {
    const source = await createCheckpointTerminal(100, 30);
    const target = await createCheckpointTerminal(100, 30);
    const coordinates = {
      historySequence: 9_007_199_254_740_997n,
      geometryGeneration: 42n,
      parserEpoch: 7n,
    };
    try {
      source.write('coordinate-bound-state');
      const checkpoint = source.captureCheckpoint(coordinates);
      expect(checkpoint.metadata).toMatchObject(coordinates);

      target.write('unchanged-on-coordinate-mismatch');
      const beforeDigest = target.getStateDigest();
      expect(() =>
        target.restoreCheckpoint(checkpoint.bytes, {
          ...coordinates,
          historySequence: coordinates.historySequence - 1n,
        })
      ).toThrow(/STATE_INVARIANT/);
      expect(target.getStateDigest()).toBe(beforeDigest);

      target.restoreCheckpoint(checkpoint.bytes, coordinates);
      expect(target.getStateDigest()).toBe(source.getStateDigest());
    } finally {
      source.free();
      target.free();
    }
  });

  test('rejects checkpoint coordinates outside unsigned 64-bit range', async () => {
    const terminal = await createCheckpointTerminal();
    const valid = { historySequence: 0n, geometryGeneration: 0n, parserEpoch: 0n };
    try {
      expect(() => terminal.captureCheckpoint({ ...valid, historySequence: -1n })).toThrow(
        /historySequence/
      );
      expect(() => terminal.captureCheckpoint({ ...valid, parserEpoch: 1n << 64n })).toThrow(
        /parserEpoch/
      );
    } finally {
      terminal.free();
    }
  });

  test('rejects malformed envelopes without mutating live state', async () => {
    const terminal = await createCheckpointTerminal();
    try {
      terminal.write('\x1b[2J\x1b[4;7H\x1b[1;35mstable');
      terminal.update();
      const beforeDigest = terminal.getStateDigest();
      const beforeCells = terminal.getViewport().map((cell) => ({ ...cell }));
      const beforeCursor = { ...terminal.getCursor() };

      for (const malformed of [
        new Uint8Array(),
        new TextEncoder().encode('wrong-magic'),
        new Uint8Array(64).fill(0xff),
      ]) {
        expect(() => terminal.validateCheckpoint(malformed)).toThrow();
        expect(() => terminal.restoreCheckpoint(malformed)).toThrow();
        expect(terminal.getStateDigest()).toBe(beforeDigest);
        expect(terminal.getViewport()).toEqual(beforeCells);
        expect(terminal.getCursor()).toEqual(beforeCursor);
      }
    } finally {
      terminal.free();
    }
  });

  test('distinguishes version, length, checksum, dimension, and resource-limit failures', async () => {
    const source = await createCheckpointTerminal(80, 24);
    const wrongSize = await createCheckpointTerminal(81, 24);
    try {
      source.write('strict-envelope');
      const checkpoint = source.captureCheckpoint().bytes;

      const unsupportedVersion = checkpoint.slice();
      new DataView(unsupportedVersion.buffer).setUint16(CHECKPOINT_MAGIC.length, 2, true);
      expect(() => source.validateCheckpoint(unsupportedVersion)).toThrow(/UNSUPPORTED_VERSION/);

      const badPayloadLength = checkpoint.slice();
      new DataView(badPayloadLength.buffer).setBigUint64(
        CHECKPOINT_MAGIC.length + 36,
        BigInt(checkpoint.length),
        true
      );
      expect(() => source.validateCheckpoint(badPayloadLength)).toThrow(/INVALID_FORMAT/);

      const badChecksum = checkpoint.slice();
      badChecksum[CHECKPOINT_HEADER_SIZE] ^= 0x01;
      expect(() => source.validateCheckpoint(badChecksum)).toThrow(/CHECKSUM_MISMATCH/);

      expect(() => wrongSize.restoreCheckpoint(checkpoint)).toThrow(/DIMENSION_MISMATCH/);

      const oversizedEngineId = checkpoint.slice();
      new DataView(oversizedEngineId.buffer).setUint32(CHECKPOINT_HEADER_SIZE, 0x01000001, true);
      rewritePayloadChecksum(oversizedEngineId);
      expect(() => source.validateCheckpoint(oversizedEngineId)).toThrow(/RESOURCE_LIMIT/);
    } finally {
      source.free();
      wrongSize.free();
    }
  });

  test('rejects every truncated prefix and captures deterministic bytes', async () => {
    const terminal = await createCheckpointTerminal(32, 8);
    try {
      terminal.write('\x1b[1;38;2;12;34;56mdeterministic 界e\u0301\x1b[0m');
      const first = terminal.captureCheckpoint();
      const second = terminal.captureCheckpoint();
      expect(second.bytes).toEqual(first.bytes);
      expect(second.metadata).toEqual(first.metadata);

      for (let length = 0; length < first.bytes.length; length++) {
        expect(() => terminal.validateCheckpoint(first.bytes.subarray(0, length))).toThrow();
      }
    } finally {
      terminal.free();
    }
  });

  test('restore is atomic and forces a full dirty frame', async () => {
    const source = await createCheckpointTerminal(100, 30);
    const target = await createCheckpointTerminal(100, 30);
    try {
      source.write('\x1b[?1049h\x1b[2J\x1b[8;12H\x1b[4;38;5;201mrestored');
      const checkpoint = source.captureCheckpoint();

      target.write('different');
      target.update();
      target.markClean();
      expect(target.update()).toBe(DirtyState.NONE);

      target.restoreCheckpoint(checkpoint.bytes);

      expect(target.getStateDigest()).toBe(source.getStateDigest());
      expect(target.getViewport()).toEqual(source.getViewport());
      expect(target.getCursor()).toEqual(source.getCursor());
      expect(target.update()).toBe(DirtyState.FULL);
    } finally {
      source.free();
      target.free();
    }
  });

  test('rejects capture while the VT or UTF-8 parser is between sequence boundaries', async () => {
    const terminal = await createCheckpointTerminal();
    try {
      terminal.write('\x1b[38;2;12;');
      expect(() => terminal.captureCheckpoint()).toThrow(/STATE_INVARIANT/);
      terminal.write('34;56mcomplete');

      terminal.write(new Uint8Array([0xf0, 0x9f]));
      expect(() => terminal.captureCheckpoint()).toThrow(/STATE_INVARIANT/);
      terminal.write(new Uint8Array([0x91, 0xa9]));

      expect(terminal.captureCheckpoint().metadata.formatVersion).toBe(1);
    } finally {
      terminal.free();
    }
  });
});
