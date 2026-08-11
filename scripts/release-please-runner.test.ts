import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { formatOutputLines, formatPrMetadata } from './release-please-runner';

describe('release-please config', () => {
  test('creates the next release as an RC prerelease for pipeline dogfooding', () => {
    const config = JSON.parse(readFileSync('release-please-config.json', 'utf8'));

    expect(config.versioning).toBe('prerelease');
    expect(config.prerelease).toBe(true);
    expect(config['prerelease-type']).toBe('rc.0');
  });
});

describe('release-please runner output formatting', () => {
  test('formats release tags, PR branches, and JSON PR metadata', () => {
    const outputs = formatOutputLines({
      releases: [{ tagName: 'v1.0.0' }, { tagName: 'v1.1.0' }],
      pullRequests: [
        { branch: 'release-please--branches--main', title: 'chore(release): 1.1.0' },
        {
          branch: 'release-please--branches--main--components--docs',
          title: 'docs: release notes',
        },
      ],
    });

    expect(outputs).toContain('releases_created=true');
    expect(outputs).toContain('release_tags=v1.0.0 v1.1.0');
    expect(outputs).toContain('prs_created=true');
    expect(outputs).toContain(
      'pr_branches=release-please--branches--main release-please--branches--main--components--docs'
    );
    expect(
      JSON.parse(
        outputs.find((line) => line.startsWith('pr_metadata='))!.slice('pr_metadata='.length)
      )
    ).toEqual([
      { branch: 'release-please--branches--main', title: 'chore(release): 1.1.0' },
      { branch: 'release-please--branches--main--components--docs', title: 'docs: release notes' },
    ]);
  });

  test('formats empty PR metadata as a stable JSON array', () => {
    expect(formatPrMetadata([])).toBe('[]');
  });

  test('manual PR mode updates the candidate branch without invoking the PR API', () => {
    const source = readFileSync('scripts/release-please-runner.ts', 'utf8');

    expect(source).toContain("RELEASE_PLEASE_MODE === 'manual-pr'");
    expect(source).toContain('buildPullRequests');
    expect(source).toContain('updateManualReleaseBranch');
    expect(source).not.toContain('manifest.createPullRequests()');
  });

  test('manual PR metadata includes an actionable compare link and version', () => {
    const outputs = formatOutputLines({
      releases: [],
      pullRequests: [
        {
          branch: 'release-please--branches--main',
          title: 'chore(release): 0.5.0-rc.1',
          version: '0.5.0-rc.1',
          repository: 'floegence/ghostty-web',
        },
      ],
      manualPrs: [
        {
          branch: 'release-please--branches--main',
          title: 'chore(release): 0.5.0-rc.1',
          version: '0.5.0-rc.1',
          repository: 'floegence/ghostty-web',
        },
      ],
    });

    expect(outputs).toContain('manual_prs_created=true');
    expect(outputs).toContain('manual_pr_versions=0.5.0-rc.1');
    expect(outputs).toContain(
      'manual_pr_links=https://github.com/floegence/ghostty-web/compare/main...release-please--branches--main?expand=1'
    );
  });

  test('workflow explicitly selects manual PR mode', () => {
    const workflow = readFileSync('.github/workflows/release-please.yml', 'utf8');

    expect(workflow).toContain('RELEASE_PLEASE_MODE: manual-pr');
    expect(workflow).toContain('  pull-requests: read');
    expect(workflow).not.toContain('  pull-requests: write');
  });
});
