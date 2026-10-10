import path from 'node:path';
import fs from 'node:fs/promises';
import type { CaptureMatch, ParsedImport } from 'gitnexus-shared';

export interface ZigResolutionConfig {
  readonly moduleRoots: ReadonlyMap<string, string>;
}

const MAX_BUILD_CONFIG_FILES = 64;
const MAX_BUILD_CONFIG_BYTES = 4 * 1024 * 1024;

/** Interpret `const alias = @import("target")` as a namespace binding. */
export function interpretZigImport(captures: CaptureMatch): ParsedImport | null {
  const localName = captures['@import.name']?.text.trim();
  const targetRaw = captures['@import.source']?.text.trim();
  if (localName === undefined || localName === '' || targetRaw === undefined || targetRaw === '') {
    return null;
  }

  const leaf = targetRaw.split('/').pop() ?? targetRaw;
  const importedName = leaf.endsWith('.zig') ? leaf.slice(0, -4) : leaf;
  return { kind: 'namespace', localName, importedName, targetRaw };
}

/**
 * Resolve file imports using Zig's source-relative semantics.
 *
 * Package imports such as `std`, `builtin`, `root`, and build-system module
 * names are deliberately left unresolved. Treating those names as suffixes
 * could connect a standard-library call to an unrelated workspace file.
 */
export function resolveZigImportTarget(
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
  resolutionConfig?: unknown,
): string | null {
  if (targetRaw === '' || path.posix.isAbsolute(targetRaw)) {
    return null;
  }

  if (targetRaw.endsWith('.zig')) {
    const candidate = path.posix.normalize(
      path.posix.join(path.posix.dirname(fromFile), targetRaw),
    );
    return allFilePaths.has(candidate) ? candidate : null;
  }

  const moduleRoots = (resolutionConfig as ZigResolutionConfig | undefined)?.moduleRoots;
  const configuredRoot = moduleRoots?.get(targetRaw);
  return configuredRoot !== undefined && allFilePaths.has(configuredRoot) ? configuredRoot : null;
}

/**
 * Load local module aliases from the repository's `build.zig`.
 *
 * The supported forms are intentionally narrow and deterministic:
 *
 *   const worker_mod = b.createModule(.{ .root_source_file = b.path("src/worker.zig") });
 *   app_mod.addImport("worker", worker_mod);
 *   b.addModule("worker", .{ .root_source_file = b.path("src/worker.zig") });
 *
 * Dependency expressions (`dependency.module(...)`) are external and remain
 * unresolved. If one alias points at more than one local root, it is omitted
 * rather than guessed.
 */
export async function loadZigResolutionConfig(repoPath: string): Promise<ZigResolutionConfig> {
  const roots = new Map<string, string>();
  const ambiguous = new Set<string>();
  const sources = await loadBuildConfigSources(repoPath);
  if (sources === null) return { moduleRoots: roots };
  for (const source of sources) collectModuleRoots(source, roots, ambiguous);

  return { moduleRoots: roots };
}

/**
 * Read `build.zig` plus local Zig files it imports as build helpers.
 *
 * Large repositories commonly move module construction into files such as
 * `build_support.zig`. Imports are followed only when they are relative `.zig`
 * paths that remain inside the repository, with deterministic file/byte caps.
 * Package imports (`std`, dependency names) and paths outside the repository
 * are never read.
 */
async function loadBuildConfigSources(repoPath: string): Promise<string[] | null> {
  const pending = ['build.zig'];
  const visited = new Set<string>();
  const sources: string[] = [];
  let totalBytes = 0;

  while (pending.length > 0) {
    // A partial build graph can connect an alias to the wrong module. If the
    // bounded scan cannot finish, refuse every build-derived alias instead.
    if (visited.size >= MAX_BUILD_CONFIG_FILES) return null;
    const relativePath = pending.shift()!;
    if (visited.has(relativePath)) continue;
    visited.add(relativePath);

    let source: string;
    try {
      source = await fs.readFile(path.join(repoPath, relativePath), 'utf8');
    } catch {
      continue;
    }
    totalBytes += Buffer.byteLength(source);
    if (totalBytes > MAX_BUILD_CONFIG_BYTES) return null;
    sources.push(source);

    const localImport = /@import\(\s*"([^"]+\.zig)"\s*\)/g;
    for (const match of source.matchAll(localImport)) {
      const target = match[1];
      if (target === undefined || path.posix.isAbsolute(target)) continue;
      const candidate = path.posix.normalize(
        path.posix.join(path.posix.dirname(relativePath), target),
      );
      if (candidate === '..' || candidate.startsWith('../')) continue;
      if (!visited.has(candidate) && !pending.includes(candidate)) pending.push(candidate);
    }
  }

  return sources;
}

function collectModuleRoots(
  source: string,
  roots: Map<string, string>,
  ambiguous: Set<string>,
): void {
  const rootByVariable = new Map<string, string>();
  const ambiguousVariables = new Set<string>();
  const createModule = /const\s+([A-Za-z_]\w*)\s*=\s*b\.createModule\(\.\{([\s\S]*?)\}\s*\);/g;
  for (const match of source.matchAll(createModule)) {
    const variable = match[1];
    const root = rootPathFromOptions(match[2] ?? '');
    if (variable !== undefined && root !== null) {
      // Helper files may reuse a local variable name in several functions.
      // A file-wide regex cannot prove lexical ownership, so refuse that
      // variable rather than attaching every addImport call to the last root.
      registerUnambiguous(rootByVariable, ambiguousVariables, variable, root);
    }
  }

  const addImport = /[A-Za-z_]\w*\.addImport\(\s*"([^"]+)"\s*,\s*([A-Za-z_]\w*)\s*\)/g;
  for (const match of source.matchAll(addImport)) {
    const alias = match[1];
    const moduleVariable = match[2];
    const root = moduleVariable === undefined ? undefined : rootByVariable.get(moduleVariable);
    if (alias !== undefined && root !== undefined)
      registerUnambiguous(roots, ambiguous, alias, root);
  }

  const addModule = /b\.addModule\(\s*"([^"]+)"\s*,\s*\.\{([\s\S]*?)\}\s*\)/g;
  for (const match of source.matchAll(addModule)) {
    const alias = match[1];
    const root = rootPathFromOptions(match[2] ?? '');
    if (alias !== undefined && root !== null) registerUnambiguous(roots, ambiguous, alias, root);
  }
}

function rootPathFromOptions(options: string): string | null {
  const match = /\.root_source_file\s*=\s*b\.path\(\s*"([^"]+)"\s*\)/.exec(options);
  const raw = match?.[1];
  if (raw === undefined || raw === '' || path.posix.isAbsolute(raw)) return null;
  const normalized = path.posix.normalize(raw);
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

function registerUnambiguous(
  roots: Map<string, string>,
  ambiguous: Set<string>,
  alias: string,
  root: string,
): void {
  if (ambiguous.has(alias)) return;
  const existing = roots.get(alias);
  if (existing === undefined || existing === root) {
    roots.set(alias, root);
    return;
  }
  roots.delete(alias);
  ambiguous.add(alias);
}
