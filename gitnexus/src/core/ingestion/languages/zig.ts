/**
 * Zig language provider.
 *
 * Key Zig traits:
 * - importSemantics: 'namespace' (imports are aliased modules via @import)
 * - type declarations are typically `const Name = struct/enum/union/opaque`
 * - methods/fields live inside container declarations
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { createClassExtractor } from '../class-extractors/generic.js';
import { zigExportChecker } from '../export-detection.js';
import { zigFieldExtractor } from '../field-extractors/zig.js';
import { resolveZigImport } from '../import-resolvers/zig.js';
import { defineLanguage } from '../language-provider.js';
import { zigMethodExtractor } from '../method-extractors/zig.js';
import { getZigQueriesForRuntime } from '../tree-sitter-queries.js';
import { typeConfig as zigConfig } from '../type-extractors/zig.js';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import { emitZigScopeCaptures } from './zig/captures.js';
import { interpretZigImport } from './zig/imports.js';

const BUILT_INS: ReadonlySet<string> = new Set([
  'assert',
  'panic',
  '@import',
  '@sizeOf',
  '@alignOf',
  '@intCast',
  '@ptrCast',
  '@bitCast',
  '@as',
  '@TypeOf',
  '@compileError',
  '@compileLog',
  '@This',
  '@field',
  '@fieldParentPtr',
  '@memcpy',
  '@memset',
  '@intFromBool',
  '@boolToInt',
  '@enumFromInt',
  '@intFromEnum',
  '@tagName',
  '@setEvalBranchQuota',
  '@setRuntimeSafety',
]);

const CONTAINER_TYPE_MAP: Record<string, 'Struct' | 'Enum' | 'Class'> = {
  struct_declaration: 'Struct',
  enum_declaration: 'Enum',
  opaque_declaration: 'Class',
};

function extractZigTypeDeclaration(node: SyntaxNode): SyntaxNode | undefined {
  return node.namedChildren.find((child) => child.type in CONTAINER_TYPE_MAP);
}

export const zigProvider = defineLanguage({
  id: SupportedLanguages.Zig,
  extensions: ['.zig'],
  treeSitterQueries: getZigQueriesForRuntime(),
  typeConfig: zigConfig,
  exportChecker: zigExportChecker,
  importResolver: resolveZigImport,
  fieldExtractor: zigFieldExtractor,
  methodExtractor: zigMethodExtractor,
  classExtractor: createClassExtractor({
    language: SupportedLanguages.Zig,
    typeDeclarationNodes: ['variable_declaration'],
    extractName(node) {
      const id = node.namedChildren.find((child) => child.type === 'identifier');
      return id?.text;
    },
    extractType(node) {
      const decl = extractZigTypeDeclaration(node);
      if (!decl) return undefined;
      return CONTAINER_TYPE_MAP[decl.type];
    },
  }),
  builtInNames: BUILT_INS,

  // RFC #909 scope-resolution hooks. The resolver-side import and binding
  // semantics live in `zig/scope-resolver.ts`.
  emitScopeCaptures: emitZigScopeCaptures,
  interpretImport: interpretZigImport,
});
