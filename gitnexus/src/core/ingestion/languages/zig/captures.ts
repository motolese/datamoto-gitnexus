import Parser from 'tree-sitter';
import { SupportedLanguages, type Capture, type CaptureMatch } from 'gitnexus-shared';
import { getTreeSitterBufferSize } from '../../constants.js';
import { nodeToCapture } from '../../utils/ast-helpers.js';
import { getLanguageGrammar } from '../../../tree-sitter/parser-loader.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';

/**
 * Scope-resolution captures for Zig.
 *
 * Keep this query separate from the legacy graph-extraction query in
 * `tree-sitter-queries.ts`: the scope pipeline consumes semantic capture names
 * (`@scope.*`, `@declaration.*`, `@import.*`, `@reference.*`) rather than the
 * legacy `@definition.*` / `@call.*` vocabulary.
 */
const ZIG_SCOPE_QUERY = `
;; Scopes
(source_file) @scope.module
(struct_declaration) @scope.class
(enum_declaration) @scope.class
(union_declaration) @scope.class
(opaque_declaration) @scope.class
(function_declaration) @scope.function
(block) @scope.block

;; Container declarations. Scope and declaration captures are intentionally
;; separate query matches because ScopeExtractor routes one topic per match.
(variable_declaration
  (identifier) @declaration.name
  (struct_declaration)) @declaration.struct

(variable_declaration
  (identifier) @declaration.name
  (enum_declaration)) @declaration.enum

(variable_declaration
  (identifier) @declaration.name
  (union_declaration)) @declaration.union

(variable_declaration
  (identifier) @declaration.name
  (opaque_declaration)) @declaration.class

;; Top-level functions and container methods share one syntactic form. The
;; owner reconciliation pass promotes functions inside a container to methods.
(function_declaration
  name: (identifier) @declaration.name) @declaration.function

;; const alias = @import("path.zig")
(variable_declaration
  (identifier) @import.name
  (builtin_function
    (builtin_identifier) @_import_builtin
    (arguments
      (string
        (string_content) @import.source)))
  (#eq? @_import_builtin "@import")) @import.statement

;; Free calls
(call_expression
  function: (identifier) @reference.name) @reference.call.free

;; Namespace, type, and value receiver calls
(call_expression
  function: (field_expression
    object: (_) @reference.receiver
    member: (identifier) @reference.name)) @reference.call.member
`;

let parser: Parser | null = null;
let query: Parser.Query | null = null;

function getZigParser(): Parser {
  if (parser === null) {
    parser = new Parser();
    parser.setLanguage(
      getLanguageGrammar(SupportedLanguages.Zig) as Parameters<Parser['setLanguage']>[0],
    );
  }
  return parser;
}

function getZigScopeQuery(): Parser.Query {
  if (query === null) {
    query = new Parser.Query(
      getLanguageGrammar(SupportedLanguages.Zig) as Parameters<Parser['setLanguage']>[0],
      ZIG_SCOPE_QUERY,
    );
  }
  return query;
}

export function emitZigScopeCaptures(
  sourceText: string,
  _filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  let tree = cachedTree as ReturnType<ReturnType<typeof getZigParser>['parse']> | undefined;
  if (tree === undefined) {
    tree = parseSourceSafe(getZigParser(), sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
  }

  const out: CaptureMatch[] = [];
  for (const match of getZigScopeQuery().matches(tree.rootNode)) {
    const grouped: Record<string, Capture> = {};
    for (const capture of match.captures) {
      const tag = `@${capture.name}`;
      if (tag.startsWith('@_')) continue;
      grouped[tag] = nodeToCapture(tag, capture.node);
    }
    if (Object.keys(grouped).length > 0) out.push(grouped);
  }
  return out;
}
