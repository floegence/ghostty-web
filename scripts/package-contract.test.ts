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
    expect(workflow).toContain('EXPECTED_PACKAGE_NAME="@floegence/ghostty-web"');
    expect(workflow).toContain('npm publish --tag "${NPM_TAG}" --provenance --access public');
    expect(workflow).not.toContain('Publish @ghostty-web/demo');
    expect(workflow).not.toContain('working-directory: demo');

    const releaseConfig = JSON.parse(await readFile('release-please-config.json', 'utf8')) as {
      packages: Record<string, { 'package-name': string }>;
    };
    expect(releaseConfig.packages['.']['package-name']).toBe('@floegence/ghostty-web');
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
