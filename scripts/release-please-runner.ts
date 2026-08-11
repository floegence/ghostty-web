import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { BaseStrategyOptions } from 'release-please/build/src/strategies/base';
import { registerAiChangelogNotes } from './release-please-ai/changelog-notes';

const nodeRequire = createRequire(import.meta.url);

export interface RunnerReleaseOutput {
  tagName: string;
}

export interface RunnerPullRequestOutput {
  branch: string;
  title: string;
  version?: string;
  repository?: string;
}

export interface RunnerOutputs {
  releases: RunnerReleaseOutput[];
  pullRequests: RunnerPullRequestOutput[];
  manualPrs?: RunnerPullRequestOutput[];
}

export function formatPrMetadata(pullRequests: RunnerPullRequestOutput[]): string {
  return JSON.stringify(pullRequests.map(({ branch, title }) => ({ branch, title })));
}

export function manualPrLink(repository: string, branch: string): string {
  return `https://github.com/${repository}/compare/main...${branch}?expand=1`;
}

function formatManualPrMetadata(pullRequests: RunnerPullRequestOutput[]): string {
  return JSON.stringify(
    pullRequests.map(({ branch, title, version, repository }) => ({
      branch,
      title,
      version,
      link: manualPrLink(repository!, branch),
    }))
  );
}

export function formatOutputLines(outputs: RunnerOutputs): string[] {
  const releaseTags = outputs.releases.map((release) => release.tagName).join(' ');
  const prBranches = outputs.pullRequests.map((pr) => pr.branch).join(' ');
  const manualPrs = outputs.manualPrs ?? [];
  return [
    `releases_created=${outputs.releases.length > 0}`,
    `release_tags=${releaseTags}`,
    `prs_created=${outputs.pullRequests.length > 0}`,
    `pr_branches=${prBranches}`,
    `pr_metadata=${formatPrMetadata(outputs.pullRequests)}`,
    `manual_prs_created=${manualPrs.length > 0}`,
    `manual_pr_versions=${manualPrs.map((pr) => pr.version ?? '').join(' ')}`,
    `manual_pr_links=${manualPrs.map((pr) => manualPrLink(pr.repository!, pr.branch)).join(' ')}`,
    `manual_pr_metadata=${formatManualPrMetadata(manualPrs)}`,
  ];
}

function writeGithubOutputs(lines: string[]): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    for (const line of lines) {
      console.log(line);
    }
    return;
  }
  appendFileSync(outputPath, `${lines.join('\n')}\n`);
}

function writeGithubSummary(pullRequests: RunnerPullRequestOutput[]): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  const lines = ['## Release Please candidate', ''];
  if (pullRequests.length === 0) {
    lines.push('No release candidate changes were found. No manual PR is required.');
  } else {
    lines.push(
      '| Version | Candidate branch | Create the release PR |',
      '| --- | --- | --- |',
      ...pullRequests.map(
        (pr) =>
          `| ${pr.version ?? 'unknown'} | \`${pr.branch}\` | [Open compare and create PR](${manualPrLink(pr.repository!, pr.branch)}) |`
      )
    );
  }
  appendFileSync(summaryPath, `${lines.join('\n')}\n`);
}

async function registerReleasePleaseExtensions(): Promise<void> {
  const { registerReleaseType } = nodeRequire('release-please/build/src/factory');
  const { Node: NodeStrategy } = nodeRequire('release-please/build/src/strategies/node');

  class GhosttyWebNodeStrategy extends NodeStrategy {
    // Release Please otherwise may suffix the release branch with the component even
    // though this single-package repository intentionally uses plain vX.Y.Z tags.
    async getBranchComponent(): Promise<string | undefined> {
      if (!this.includeComponentInTag) {
        return undefined;
      }
      return super.getBranchComponent();
    }
  }

  registerAiChangelogNotes();
  registerReleaseType(
    'node',
    (options: BaseStrategyOptions) => new GhosttyWebNodeStrategy(options)
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parseRepository(repository: string): { owner: string; repo: string } {
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) {
    throw new Error(`GITHUB_REPOSITORY must be in owner/repo form, got ${repository}`);
  }
  return { owner, repo };
}

function tagNameFromRelease(release: { tag: { toString(): string } }): string {
  return release.tag.toString();
}

/**
 * Apply Release Please's candidate updates to the release branch without calling
 * the GitHub pull-request API. The organization intentionally requires a human
 * to open and approve the release PR from the generated branch.
 */
export async function updateManualReleaseBranch(
  github: unknown,
  targetBranch: string,
  pullRequest: {
    headRefName: string;
    title: { toString(): string };
    updates: unknown[];
  }
): Promise<void> {
  const client = github as {
    octokit: unknown;
    repository: { owner: string; repo: string };
    buildChangeSet(updates: unknown[], target: string): Promise<Map<string, unknown>>;
  };
  const { branch } = nodeRequire('release-please/build/src/util/code-suggester/github/branch');
  const { commitAndPush: writeCommitAndPush } = nodeRequire(
    'release-please/build/src/util/code-suggester/github/commit-and-push'
  );
  const origin = client.repository;
  const changes = await client.buildChangeSet(pullRequest.updates, targetBranch);
  if (changes.size === 0) {
    return;
  }
  const baseSha = await branch(
    client.octokit,
    origin,
    origin,
    pullRequest.headRefName,
    targetBranch
  );
  await writeCommitAndPush(
    client.octokit,
    baseSha,
    changes,
    { ...origin, branch: pullRequest.headRefName },
    pullRequest.title.toString(),
    true
  );
}

function manualPullRequestOutput(
  repository: string,
  pullRequest: {
    headRefName: string;
    title: { toString(): string };
    version?: { toString(): string };
  }
): RunnerPullRequestOutput {
  return {
    branch: pullRequest.headRefName,
    title: pullRequest.title.toString(),
    version: pullRequest.version?.toString(),
    repository,
  };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const token = requireEnv('GITHUB_TOKEN');
  const { owner, repo } = parseRepository(requireEnv('GITHUB_REPOSITORY'));
  const targetBranch = process.env.RELEASE_PLEASE_TARGET_BRANCH || 'main';
  const manualPrMode = process.env.RELEASE_PLEASE_MODE === 'manual-pr';
  if (!manualPrMode) {
    throw new Error('RELEASE_PLEASE_MODE must be explicitly set to manual-pr');
  }
  const configFile = process.env.RELEASE_PLEASE_CONFIG_FILE || 'release-please-config.json';
  const manifestFile = process.env.RELEASE_PLEASE_MANIFEST_FILE || '.release-please-manifest.json';

  await registerReleasePleaseExtensions();

  const { GitHub } = nodeRequire('release-please/build/src/github');
  const { Manifest } = nodeRequire('release-please/build/src/manifest');
  const github = await GitHub.create({ owner, repo, token });
  const manifest = await Manifest.fromManifest(github, targetBranch, configFile, manifestFile);

  if (dryRun) {
    const releases = await manifest.buildReleases();
    const pullRequests = await manifest.buildPullRequests();
    const preview = {
      dryRun: true,
      releases: releases.map((release) => ({
        tag: tagNameFromRelease(release),
        name: release.name,
        sha: release.sha,
        notes: release.notes,
      })),
      pullRequests: pullRequests.map((pullRequest) => ({
        branch: pullRequest.headRefName,
        title: pullRequest.title.toString(),
        version: pullRequest.version?.toString(),
        updates: pullRequest.updates.map((update) => update.path),
        body: pullRequest.body.toString(),
      })),
    };
    console.log(JSON.stringify(preview, null, 2));
    writeGithubOutputs(
      formatOutputLines({
        releases: releases.map((release) => ({ tagName: tagNameFromRelease(release) })),
        pullRequests: pullRequests.map((pullRequest) => ({
          branch: pullRequest.headRefName,
          title: pullRequest.title.toString(),
        })),
        manualPrs: pullRequests.map((pullRequest) =>
          manualPullRequestOutput(`${owner}/${repo}`, pullRequest)
        ),
      })
    );
    writeGithubSummary(
      pullRequests.map((pullRequest) => manualPullRequestOutput(`${owner}/${repo}`, pullRequest))
    );
    return;
  }

  const createdReleases = (await manifest.createReleases()).filter(
    (release) => release !== undefined
  );
  const pullRequests = await manifest.buildPullRequests();
  const manualPrs = pullRequests.map((pullRequest) =>
    manualPullRequestOutput(`${owner}/${repo}`, pullRequest)
  );
  for (const pullRequest of pullRequests) {
    await updateManualReleaseBranch(github, targetBranch, pullRequest);
  }
  writeGithubOutputs(
    formatOutputLines({
      releases: createdReleases.map((release) => ({ tagName: release.tagName })),
      pullRequests: manualPrs,
      manualPrs,
    })
  );
  writeGithubSummary(manualPrs);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
