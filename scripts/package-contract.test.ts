import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

interface PackageManifest {
  name: string;
  repository: { url: string };
  bugs: string;
  homepage: string;
  files: string[];
  scripts: Record<string, string>;
}

describe('floegence fork package contract', () => {
  test('owns the scoped package identity and release metadata', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8')) as PackageManifest;
    expect(manifest.name).toBe('@floegence/ghostty-web');
    expect(manifest.repository.url).toBe('https://github.com/floegence/ghostty-web.git');
    expect(manifest.bugs).toBe('https://github.com/floegence/ghostty-web/issues');
    expect(manifest.homepage).toBe('https://github.com/floegence/ghostty-web#readme');
    expect(manifest.files).toEqual(
      expect.arrayContaining([
        'dist',
        'ghostty-vt.wasm',
        'README.md',
        'LICENSE',
        'THIRD_PARTY_NOTICES.md',
      ])
    );
    expect(manifest.scripts.build).toContain('build:provenance');
    expect(manifest.scripts.build).toContain('build:verify-artifacts');
  });

  test('publishes only the scoped fork package with provenance', async () => {
    const workflow = await readFile('.github/workflows/publish.yml', 'utf8');
    const nodeVersions = [...workflow.matchAll(/node-version:\s*['"]?(\d+)/g)].map(
      ([, version]) => version
    );
    expect(nodeVersions).toEqual(['24', '24', '24']);
    expect(workflow).toContain('EXPECTED_PACKAGE_NAME="@floegence/ghostty-web"');
    expect(workflow).toContain('npm publish --tag "${NPM_TAG}" --provenance --access public');
    expect(workflow).not.toContain('Publish @ghostty-web/demo');
    expect(workflow).not.toContain('working-directory: demo');

    const releaseConfig = JSON.parse(await readFile('release-please-config.json', 'utf8')) as {
      packages: Record<string, { 'package-name': string }>;
    };
    expect(releaseConfig.packages['.']['package-name']).toBe('@floegence/ghostty-web');
  });

  test('pins Bun for reproducible CI and release installs', async () => {
    const ci = await readFile('.github/workflows/ci.yml', 'utf8');
    const publish = await readFile('.github/workflows/publish.yml', 'utf8');

    expect(
      [...ci.matchAll(/bun-version:\s*['"]?([^'"\n]+)['"]?/g)].map(([, version]) => version)
    ).toEqual(['1.3.11', '1.3.11', '1.3.11', '1.3.11', '1.3.11']);
    expect(
      [...publish.matchAll(/bun-version:\s*['"]?([^'"\n]+)['"]?/g)].map(([, version]) => version)
    ).toEqual(['1.3.11', '1.3.11']);
  });

  test('builds the WASM artifact before running release tests', async () => {
    const workflow = await readFile('.github/workflows/publish.yml', 'utf8');
    const stableJob = workflow.slice(0, workflow.indexOf('  publish-next:'));
    const buildWasm = stableJob.indexOf('- name: Build WASM');
    const runTests = stableJob.indexOf('- name: Run tests');

    expect(buildWasm).toBeGreaterThan(-1);
    expect(runTests).toBeGreaterThan(buildWasm);
  });

  test('limits the bootstrap token to the explicit first scoped RC publish', async () => {
    const workflow = await readFile('.github/workflows/publish.yml', 'utf8');

    expect(workflow).toContain('bootstrap:');
    expect(workflow).toContain('BOOTSTRAP_REQUESTED: ${{ inputs.bootstrap }}');
    expect(workflow).toContain('EVENT_NAME: ${{ github.event_name }}');
    expect(workflow).toContain('[[ "$TAG" == "v0.5.0-rc.0" ]]');
    expect(workflow).toContain('npm view "$PACKAGE_NAME" name');
    expect(workflow).toContain('Registry lookup must fail with E404 before bootstrap');
    expect(workflow.match(/NPM_BOOTSTRAP_TOKEN/g)).toHaveLength(2);
    expect(workflow.match(/NODE_AUTH_TOKEN/g)).toHaveLength(2);
    expect(workflow).toContain("if: steps.tag.outputs.bootstrap != 'true'");
    expect(workflow).toContain("if: steps.tag.outputs.bootstrap == 'true'");
    expect(workflow).toContain('npm publish --tag "${NPM_TAG}" --provenance --access public');
    expect(workflow).toContain('npm publish --tag next --provenance --access public');
  });

  test('guards the one-time bootstrap latest-tag cleanup', async () => {
    const workflow = await readFile('.github/workflows/publish.yml', 'utf8');

    expect(workflow).toContain('cleanup_bootstrap_latest:');
    expect(workflow).toContain(
      "github.event_name == 'workflow_dispatch' && inputs.cleanup_bootstrap_latest == true"
    );
    expect(workflow).toContain('EXPECTED_PACKAGE_NAME="@floegence/ghostty-web"');
    expect(workflow).toContain('EXPECTED_VERSION="0.5.0-rc.0"');
    expect(workflow).toContain('test "$INPUT_TAG" = "v0.5.0-rc.0"');
    expect(workflow).toContain('test "$BOOTSTRAP_REQUESTED" = "false"');
    expect(workflow).toContain('const tags = Array.isArray(raw) ? raw[0] : raw;');
    expect(workflow).toContain('tags.latest !== expectedVersion || tags.rc !== expectedVersion');
    expect(workflow).toContain('npm dist-tag rm "$PACKAGE_NAME" latest');
    expect(workflow).toContain("Object.hasOwn(tags, 'latest') || tags.rc !== expectedVersion");
  });

  test('documents fork ownership and the pinned Ghostty patch boundary', async () => {
    const readme = await readFile('README.md', 'utf8');
    expect(readme).toContain('@floegence/ghostty-web');
    expect(readme).toContain('FloeTerm-maintained fork');
    expect(readme).toContain('5714ed07a1012573261b7b7e3ed2add9c1504496');
    expect(readme).toContain('patches/ghostty-wasm-api.patch');

    const notices = await readFile('THIRD_PARTY_NOTICES.md', 'utf8');
    expect(notices).toContain('Ghostty');
    expect(notices).toContain('MIT License');

    const publicSources = `${await readFile('lib/index.ts', 'utf8')}\n${await readFile(
      'lib/terminal.ts',
      'utf8'
    )}`;
    expect(publicSources).not.toContain('@cmux/ghostty-terminal');
    expect(publicSources).not.toMatch(/from ['"]ghostty-web['"]/);
  });
});
