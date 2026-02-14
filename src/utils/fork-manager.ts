/**
 * Fork/Upstream Management for MCPs
 *
 * Handles synchronization with parent repositories and contribution back.
 * Uses execSync for git commands - these are safe as inputs are controlled paths, not user strings.
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

export interface ForkInfo {
  path: string;
  isGitRepo: boolean;
  hasUpstream: boolean;
  upstreamUrl?: string;
  originUrl?: string;
  isAheadOfUpstream: boolean;
  commitsAhead: number;
  commitsBehind: number;
}

/**
 * Detect if MCP is a git repository with upstream
 */
export function detectForkStatus(mcpPath: string): ForkInfo {
  const info: ForkInfo = {
    path: mcpPath,
    isGitRepo: existsSync(join(mcpPath, '.git')),
    hasUpstream: false,
    isAheadOfUpstream: false,
    commitsAhead: 0,
    commitsBehind: 0,
  };

  if (!info.isGitRepo) {
    return info;
  }

  try {
    // Check for upstream remote
    const remotes = execSync('git remote -v', { cwd: mcpPath, encoding: 'utf-8' });

    if (remotes.includes('upstream')) {
      info.hasUpstream = true;
      const upstreamMatch = remotes.match(/upstream\s+(\S+)\s+\(fetch\)/);
      if (upstreamMatch) {
        info.upstreamUrl = upstreamMatch[1];
      }
    }

    const originMatch = remotes.match(/origin\s+(\S+)\s+\(fetch\)/);
    if (originMatch) {
      info.originUrl = originMatch[1];
    }

    // Check commits ahead/behind upstream
    if (info.hasUpstream) {
      try {
        execSync('git fetch upstream', { cwd: mcpPath, stdio: 'ignore' });
        const status = execSync('git rev-list --left-right --count HEAD...upstream/main', {
          cwd: mcpPath,
          encoding: 'utf-8',
        }).trim();

        const [ahead, behind] = status.split('\t').map(Number);
        info.commitsAhead = ahead || 0;
        info.commitsBehind = behind || 0;
        info.isAheadOfUpstream = info.commitsAhead > 0;
      } catch (error) {
        // Might be upstream/master instead of upstream/main
        try {
          const status = execSync('git rev-list --left-right --count HEAD...upstream/master', {
            cwd: mcpPath,
            encoding: 'utf-8',
          }).trim();
          const [ahead, behind] = status.split('\t').map(Number);
          info.commitsAhead = ahead || 0;
          info.commitsBehind = behind || 0;
          info.isAheadOfUpstream = info.commitsAhead > 0;
        } catch {
          // Unable to determine
        }
      }
    }
  } catch (error) {
    console.error(`Error checking fork status for ${mcpPath}:`, error);
  }

  return info;
}

/**
 * TODO: Implement upstream sync decision logic
 *
 * This is a KEY BUSINESS LOGIC decision. Consider:
 * - Should we auto-merge upstream changes?
 * - Should we ask user first?
 * - What if there are conflicts?
 * - Should we create a backup branch first?
 *
 * Trade-offs:
 * - Auto-merge: Fast, but might break local changes
 * - Ask first: Safe, but requires user interaction
 * - Backup branch: Safest, but creates branch clutter
 *
 * @param mcpPath - Path to MCP directory
 * @param forkInfo - Fork information
 * @returns True if sync should proceed
 */
export function shouldSyncFromUpstream(
  mcpPath: string,
  forkInfo: ForkInfo
): boolean {
  // TODO: Implement your sync decision logic here
  //
  // Suggested approach:
  // 1. Check if we're behind upstream (forkInfo.commitsBehind > 0)
  // 2. Check for uncommitted local changes (git status --porcelain)
  // 3. Decide based on:
  //    - How far behind we are
  //    - Whether there are local changes
  //    - User preference (could read from config)
  // 4. Return true to proceed with sync

  // Example logic (you can replace this):
  if (!forkInfo.hasUpstream || forkInfo.commitsBehind === 0) {
    return false; // Nothing to sync
  }

  // Check for uncommitted changes
  try {
    const status = execSync('git status --porcelain', {
      cwd: mcpPath,
      encoding: 'utf-8',
    }).trim();

    if (status) {
      console.warn(`${mcpPath} has uncommitted changes. Skipping upstream sync.`);
      return false;
    }
  } catch {
    return false;
  }

  // Your decision logic here
  return forkInfo.commitsBehind > 0 && forkInfo.commitsBehind < 50; // Example threshold
}

/**
 * Sync changes from upstream
 */
export function syncFromUpstream(mcpPath: string, forkInfo: ForkInfo): void {
  try {
    console.log(`Syncing ${mcpPath} from upstream...`);

    // Fetch upstream
    execSync('git fetch upstream', { cwd: mcpPath, stdio: 'inherit' });

    // Try main branch first, fall back to master
    try {
      execSync('git merge upstream/main --ff-only', { cwd: mcpPath, stdio: 'inherit' });
    } catch {
      execSync('git merge upstream/master --ff-only', { cwd: mcpPath, stdio: 'inherit' });
    }

    console.log(`✓ Synced ${mcpPath} from upstream`);
  } catch (error) {
    console.error(`Failed to sync ${mcpPath}:`, error);
    throw error;
  }
}

/**
 * TODO: Implement contribution decision logic
 *
 * This is a KEY BUSINESS LOGIC decision. Consider:
 * - What qualifies as "considerable improvements"?
 * - Should we check commit messages for certain keywords?
 * - Should we look at diff size?
 * - Should we always ask user before creating PR?
 *
 * Trade-offs:
 * - Auto-create PR: Fast contribution, but might spam parent repo
 * - Ask first: User control, but requires interaction
 * - Heuristics: Smart filtering, but might miss good contributions
 *
 * @param mcpPath - Path to MCP directory
 * @param forkInfo - Fork information
 * @returns True if contribution should be offered
 */
export function shouldContributeToUpstream(
  mcpPath: string,
  forkInfo: ForkInfo
): boolean {
  // TODO: Implement your contribution decision logic here
  //
  // Suggested approach:
  // 1. Check if we're ahead of upstream (forkInfo.commitsAhead > 0)
  // 2. Analyze commits since upstream:
  //    - Look at commit messages for keywords (feature, fix, improve)
  //    - Check diff size (lines changed)
  //    - Check if tests were added
  // 3. Decide based on significance of changes
  // 4. Return true to offer creating PR

  // Example logic (you can replace this):
  if (!forkInfo.hasUpstream || !forkInfo.isAheadOfUpstream) {
    return false;
  }

  // Your heuristics here
  // - Check commit messages
  // - Analyze diff size
  // - Look for test additions
  // - Check for breaking changes

  return forkInfo.commitsAhead >= 3; // Example: 3+ commits might be worth contributing
}

/**
 * Create PR to upstream repository
 */
export function createUpstreamPR(
  mcpPath: string,
  forkInfo: ForkInfo,
  title: string,
  body: string
): void {
  try {
    console.log(`Creating PR to upstream for ${mcpPath}...`);

    // Push to origin first
    execSync('git push origin HEAD', { cwd: mcpPath, stdio: 'inherit' });

    // Create PR using gh CLI
    execSync(`gh pr create --title "${title}" --body "${body}" --repo ${forkInfo.upstreamUrl}`, {
      cwd: mcpPath,
      stdio: 'inherit',
    });

    console.log(`✓ Created PR for ${mcpPath}`);
  } catch (error) {
    console.error(`Failed to create PR for ${mcpPath}:`, error);
    throw error;
  }
}
