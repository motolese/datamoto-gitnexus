/**
 * Explicit GitNexus invocation selection.
 *
 * This used to live in a copied lifecycle-hook helper. Datamoto does not use
 * editor hooks: the CLI owns this small deterministic resolver directly and
 * indexing is invoked explicitly.
 */

import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';

export type InvocationMode = 'gitnexus' | 'pnpm' | 'npx';

interface VersionDeps {
  npmMajor?: number | null;
  pnpmMajor?: number | null;
  pnpmMinor?: number | null;
  pnpmPresent?: boolean;
}

interface AnalyzeOptions {
  embeddings?: boolean;
}

interface PathOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export const NPX_REF = 'gitnexus@latest';
const PROBE_TIMEOUT_MS = 1000;

function probeVersion(command: string): { major: number; minor: number } | null {
  try {
    const output = execFileSync(command, ['--version'], {
      encoding: 'utf-8',
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    const match = output
      .split('\n')
      .map((line) => line.trim())
      .find((line) => /^v?\d+\.\d+/.test(line))
      ?.match(/^v?(\d+)\.(\d+)/);
    return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
  } catch {
    return null;
  }
}

function canExecute(filePath: string, platform: NodeJS.Platform): boolean {
  try {
    accessSync(filePath, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Spawn-free PATH resolution used by generated hints and tests. */
export function resolveOnPath(
  command: string,
  preferExecExt = false,
  options: PathOptions = {},
): string | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const rawPath = env.PATH;
  if (!rawPath) return null;

  const directories = rawPath.split(platform === 'win32' ? ';' : path.delimiter).filter(Boolean);
  if (platform !== 'win32') {
    for (const directory of directories) {
      const candidate = path.join(directory, command);
      if (canExecute(candidate, platform)) return candidate;
    }
    return null;
  }

  const pathExt = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .map((extension) => extension.toLowerCase());
  const preferred = ['.cmd', '.bat', '.exe'];
  const extensions = preferExecExt
    ? [...preferred.filter((extension) => pathExt.includes(extension)), ...pathExt.filter((extension) => !preferred.includes(extension))]
    : pathExt;
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (canExecute(candidate, platform)) return candidate;
    }
  }
  return null;
}

export function resolveInvocationMode(
  probe: (command: string, preferExecExt?: boolean) => string | null = resolveOnPath,
  deps: VersionDeps = {},
): InvocationMode {
  const forced = process.env.GITNEXUS_INVOCATION;
  if (forced === 'gitnexus' || forced === 'pnpm' || forced === 'npx') return forced;
  if (probe('gitnexus', true)) return 'gitnexus';

  const npmMajor = Object.prototype.hasOwnProperty.call(deps, 'npmMajor')
    ? deps.npmMajor ?? null
    : probeVersion('npm')?.major ?? null;
  const pnpmPresent = Object.prototype.hasOwnProperty.call(deps, 'pnpmPresent')
    ? deps.pnpmPresent === true
    : Boolean(probe('pnpm', true));
  if ((npmMajor === null || npmMajor >= 11) && pnpmPresent) return 'pnpm';
  return 'npx';
}

export function formatPnpmAllowBuildArgs(
  options: AnalyzeOptions & { alwaysAllowBuild?: boolean } = {},
  deps: Pick<VersionDeps, 'pnpmMajor' | 'pnpmMinor'> = {},
): string[] {
  const detected =
    deps.pnpmMajor === undefined && deps.pnpmMinor === undefined ? probeVersion('pnpm') : null;
  const major = deps.pnpmMajor === undefined ? detected?.major ?? null : deps.pnpmMajor;
  const minor = deps.pnpmMinor === undefined ? detected?.minor ?? null : deps.pnpmMinor;
  const supportsAllowBuild =
    options.alwaysAllowBuild === true ||
    major === null ||
    major > 10 ||
    (major === 10 && (minor === null || minor >= 2));
  if (!supportsAllowBuild) return [];

  const packages = ['@ladybugdb/core', 'gitnexus', 'tree-sitter'];
  if (options.embeddings) packages.push('onnxruntime-node');
  return packages.map((name) => `--allow-build=${name}`);
}

export function buildRunnerArgv(
  mode: InvocationMode,
  gitnexusArgs: string[],
  deps: Pick<VersionDeps, 'pnpmMajor' | 'pnpmMinor'> = {},
): { program: string; args: string[] } {
  if (mode === 'gitnexus') return { program: 'gitnexus', args: gitnexusArgs };
  if (mode === 'npx') return { program: 'npx', args: [NPX_REF, ...gitnexusArgs] };
  const embeddings = gitnexusArgs.some(
    (argument) => argument === '--embeddings' || argument.startsWith('--embeddings='),
  );
  return {
    program: 'pnpm',
    args: [
      ...formatPnpmAllowBuildArgs({ embeddings }, deps),
      'dlx',
      NPX_REF,
      ...gitnexusArgs,
    ],
  };
}

export function formatAnalyzeCommand(
  options: AnalyzeOptions = {},
  deps: VersionDeps = {},
): string {
  const argv = buildRunnerArgv(
    resolveInvocationMode(undefined, deps),
    ['analyze', ...(options.embeddings ? ['--embeddings'] : [])],
    deps,
  );
  return [argv.program, ...argv.args].join(' ');
}

export function formatDocumentationDlxCommand(
  gitnexusArgs: string,
  options: AnalyzeOptions = {},
): string {
  const allow = formatPnpmAllowBuildArgs(
    { ...options, alwaysAllowBuild: true },
    { pnpmMajor: null, pnpmMinor: null },
  );
  return ['pnpm', ...allow, 'dlx', NPX_REF, gitnexusArgs].join(' ');
}

export function getNpmMajorVersion(): number | null {
  return probeVersion('npm')?.major ?? null;
}

/** Warn only when npm 11+ would take the known npx/arborist crash path. */
export function warnIfNpm11NpxRisk(): void {
  if (resolveInvocationMode() !== 'npx') return;
  const major = getNpmMajorVersion();
  if (major === null || major < 11) return;
  process.stderr.write(
    `Warning: npm ${major}.x can crash while installing gitnexus via npx ` +
      `(npm/arborist "node.target is null"). Prefer: ${formatDocumentationDlxCommand('analyze')} ` +
      `or npm install -g ${NPX_REF}. See https://github.com/abhigyanpatwari/GitNexus/issues/1939\n`,
  );
}
