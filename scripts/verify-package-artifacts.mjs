import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);
const rootPath = root.pathname;

function git(args) {
  return execFileSync('git', args, { cwd: rootPath, encoding: 'utf8' }).trim();
}

async function json(path) {
  return JSON.parse(await readFile(new URL(path, root), 'utf8'));
}

async function hash(path) {
  return createHash('sha256')
    .update(await readFile(new URL(path, root)))
    .digest('hex');
}

const packageJson = await json('package.json');
const provenance = await json('dist/GHOSTTY_PROVENANCE.json');
const sbom = await json('dist/SBOM.spdx.json');
const wasm = await readFile(new URL('ghostty-vt.wasm', root));
const distWasm = await readFile(new URL('dist/ghostty-vt.wasm', root));
const expectedCommit = process.env.GITHUB_SHA ?? git(['rev-parse', 'HEAD']);
const expectedSubmodule = git(['-C', 'ghostty', 'rev-parse', 'HEAD']);
const expectedPatchHash = await hash('patches/ghostty-wasm-api.patch');
const expectedWasmHash = createHash('sha256').update(wasm).digest('hex');

assert.equal(packageJson.name, '@floegence/ghostty-web');
assert.equal(provenance.schema, 'floegence-ghostty-web-provenance-v1');
assert.equal(provenance.package, packageJson.name);
assert.equal(provenance.version, packageJson.version);
assert.equal(provenance.source.commit, expectedCommit);
assert.equal(provenance.engine.ghosttySubmoduleCommit, expectedSubmodule);
assert.equal(provenance.patch.sha256, expectedPatchHash);
assert.equal(provenance.engine.wasmSha256, expectedWasmHash);
assert.equal(provenance.engine.wasmBytes, wasm.length);
assert.ok(wasm.length <= 524288, `WASM is ${wasm.length} bytes; limit is 524288`);
assert.deepEqual(distWasm, wasm);
assert.equal(sbom.spdxVersion, 'SPDX-2.3');
assert.equal(sbom.packages[0].name, packageJson.name);
assert.equal(sbom.packages[0].versionInfo, packageJson.version);
assert.equal(sbom.packages[0].checksums[0].checksumValue, expectedWasmHash);
assert.equal(sbom.packages[1].name, 'ghostty');
assert.equal(sbom.packages[1].versionInfo, expectedSubmodule);
