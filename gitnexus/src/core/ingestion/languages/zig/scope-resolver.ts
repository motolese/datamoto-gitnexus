import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { collectNamespaceTargets } from '../../scope-resolution/scope/namespace-targets.js';
import {
  moduleScopeIdOf,
  populateClassOwnedMembers,
} from '../../scope-resolution/scope/walkers.js';
import { zigProvider } from '../zig.js';
import { loadZigResolutionConfig, resolveZigImportTarget } from './imports.js';

/**
 * Resolve a Zig namespace chain such as `pkg.customs.verify()`.
 *
 * The shared receiver pass already resolves one-hop `module.member()` calls.
 * Zig package roots commonly re-export source files as `pub const name =
 * @import("name.zig")`, which leaves the receiver as a dotted namespace chain.
 * Walk only finalized namespace-import edges and refuse missing or ambiguous
 * hops; value/member chains are deliberately outside this resolver.
 */
function resolveZigQualifiedNamespaceMember(
  receiverName: string,
  memberName: string,
  callerScope: string,
  scopes: Parameters<NonNullable<ScopeResolver['resolveQualifiedReceiverMember']>>[3],
  parsedFiles: readonly ParsedFile[],
): ReturnType<NonNullable<ScopeResolver['resolveQualifiedReceiverMember']>> {
  if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(receiverName)) return undefined;

  const callerModule = moduleScopeIdOf(callerScope, scopes);
  if (callerModule === null) return undefined;

  const parsedByModule = new Map(parsedFiles.map((parsed) => [parsed.moduleScope, parsed]));
  const parsedByPath = new Map(parsedFiles.map((parsed) => [parsed.filePath, parsed]));
  let current = parsedByModule.get(callerModule);
  if (current === undefined) return undefined;

  for (const segment of receiverName.split('.')) {
    const targets = collectNamespaceTargets(current, scopes).get(segment);
    if (targets === undefined || targets.length === 0) return undefined;
    if (targets.length !== 1) return 'ambiguous';

    const next = parsedByPath.get(targets[0]!);
    if (next === undefined) return undefined;
    current = next;
  }

  const moduleScope = current.scopes.find((scope) => scope.id === current.moduleScope);
  const refs = moduleScope?.bindings.get(memberName);
  if (refs === undefined) return undefined;

  const localDefs = new Map(
    refs.filter((ref) => ref.origin === 'local').map((ref) => [ref.def.nodeId, ref.def]),
  );
  if (localDefs.size === 0) return undefined;
  if (localDefs.size !== 1) return 'ambiguous';
  return localDefs.values().next().value;
}

/** Zig scope-resolution wiring for CALLS and IMPORTS relationships. */
export const zigScopeResolver: ScopeResolver = {
  language: SupportedLanguages.Zig,
  languageProvider: zigProvider,
  importEdgeReason: 'zig-scope: @import',

  loadResolutionConfig: loadZigResolutionConfig,

  resolveImportTarget: (targetRaw, fromFile, allFilePaths, resolutionConfig) =>
    resolveZigImportTarget(targetRaw, fromFile, allFilePaths, resolutionConfig),

  mergeBindings: (existing, incoming) => [...existing, ...incoming],

  arityCompatibility: (callsite, def) => {
    if (callsite.arity === undefined || def.parameterCount === undefined) return 'unknown';
    return callsite.arity === def.parameterCount ? 'compatible' : 'incompatible';
  },

  buildMro: () => new Map(),

  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),

  resolveQualifiedReceiverMember: (receiverName, memberName, callerScope, scopes, parsedFiles) =>
    resolveZigQualifiedNamespaceMember(receiverName, memberName, callerScope, scopes, parsedFiles),

  isSuperReceiver: () => false,

  fieldFallbackOnMethodLookup: false,
  propagatesReturnTypesAcrossImports: false,
  allowGlobalFreeCallFallback: false,
};
