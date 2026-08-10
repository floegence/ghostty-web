import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);
const rootPath = root.pathname;

function command(commandName, args, fallback) {
  try {
    return execFileSync(commandName, args, { cwd: rootPath, encoding: 'utf8' }).trim();
  } catch {
    return fallback;
  }
}

async function sha256(path) {
  const bytes = await readFile(new URL(path, root));
  return createHash('sha256').update(bytes).digest('hex');
}

const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const forkCommit = process.env.GITHUB_SHA ?? command('git', ['rev-parse', 'HEAD'], 'unknown');
const submoduleCommit = command(
  'git',
  ['-C', 'ghostty', 'rev-parse', 'HEAD'],
  '5714ed07a1012573261b7b7e3ed2add9c1504496'
);
const patchSha256 = await sha256('patches/ghostty-wasm-api.patch');
const wasmBytes = await readFile(new URL('ghostty-vt.wasm', root));
const wasmSha256 = createHash('sha256').update(wasmBytes).digest('hex');
const sourceDate = command('git', ['show', '-s', '--format=%cI', forkCommit], 'unknown');
const zigVersion = process.env.ZIG_VERSION ?? command('zig', ['version'], '0.15.2');
const bunVersion = command('bun', ['--version'], 'unknown');

const provenance = {
  schema: 'floegence-ghostty-web-provenance-v1',
  package: packageJson.name,
  version: packageJson.version,
  source: {
    repository: 'https://github.com/floegence/ghostty-web',
    commit: forkCommit,
    sourceDate,
  },
  engine: {
    id: 'floegence/ghostty-web',
    ghosttySubmoduleCommit: submoduleCommit,
    wasmSha256,
    wasmBytes: wasmBytes.length,
    wasmSizeLimitBytes: 524288,
    wasmBuild: { zig: zigVersion, bun: bunVersion },
  },
  patch: {
    path: 'patches/ghostty-wasm-api.patch',
    sha256: patchSha256,
  },
  checkpoint: {
    format: 'FLOE-GHOSTTY-CKPT',
    formatVersion: 1,
    restore: 'same-engine-validated-atomic',
  },
};

const sbom = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: `${packageJson.name}-${packageJson.version}`,
  documentNamespace: `https://github.com/floegence/ghostty-web/sbom/${forkCommit}`,
  creationInfo: {
    created: sourceDate,
    creators: ['Organization: Floegence'],
  },
  packages: [
    {
      SPDXID: 'SPDXRef-Package-FloeGhosttyWeb',
      name: packageJson.name,
      versionInfo: packageJson.version,
      downloadLocation: 'https://github.com/floegence/ghostty-web',
      licenseConcluded: 'MIT',
      licenseDeclared: 'MIT',
      checksums: [{ algorithm: 'SHA256', checksumValue: wasmSha256 }],
    },
    {
      SPDXID: 'SPDXRef-Package-Ghostty',
      name: 'ghostty',
      versionInfo: submoduleCommit,
      downloadLocation: 'https://github.com/ghostty-org/ghostty',
      licenseConcluded: 'MIT',
      licenseDeclared: 'MIT',
    },
  ],
  relationships: [
    {
      spdxElementId: 'SPDXRef-Package-FloeGhosttyWeb',
      relationshipType: 'CONTAINS',
      relatedSpdxElement: 'SPDXRef-Package-Ghostty',
    },
  ],
};

await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(
  new URL('dist/GHOSTTY_PROVENANCE.json', root),
  `${JSON.stringify(provenance, null, 2)}\n`
);
await writeFile(new URL('dist/SBOM.spdx.json', root), `${JSON.stringify(sbom, null, 2)}\n`);
