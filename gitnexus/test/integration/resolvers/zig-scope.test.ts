import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import {
  getLanguageGrammar,
  isLanguageAvailable,
  loadParser,
} from '../../../src/core/tree-sitter/parser-loader.js';
import { getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

let zigAvailable = isLanguageAvailable(SupportedLanguages.Zig);
if (zigAvailable) {
  try {
    await loadParser();
    getLanguageGrammar(SupportedLanguages.Zig);
  } catch {
    zigAvailable = false;
  }
}

describe.skipIf(!zigAvailable)('Zig scope relationships', () => {
  let result: PipelineResult;
  let fixtureRoot: string;

  beforeAll(async () => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-zig-scope-'));
    fs.writeFileSync(
      path.join(fixtureRoot, 'main.zig'),
      [
        'const std = @import("std");',
        'const file_worker = @import("worker.zig");',
        'const package_worker = @import("package_worker");',
        'const package = @import("package");',
        'const ambiguous = @import("ambiguous");',
        '',
        'fn localCheck() void {}',
        '',
        'pub fn main() void {',
        '    localCheck();',
        '    file_worker.run();',
        '    package_worker.execute();',
        '    package.nested.verify();',
        '    ambiguous.clash();',
        '    std.debug.print("ok\\n", .{});',
        '}',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(path.join(fixtureRoot, 'worker.zig'), 'pub fn run() void {}\n', 'utf8');
    fs.writeFileSync(
      path.join(fixtureRoot, 'package_worker.zig'),
      'pub fn execute() void {}\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(fixtureRoot, 'package_root.zig'),
      'pub const nested = @import("nested.zig");\n',
      'utf8',
    );
    fs.writeFileSync(path.join(fixtureRoot, 'nested.zig'), 'pub fn verify() void {}\n', 'utf8');
    fs.writeFileSync(path.join(fixtureRoot, 'ambiguous_a.zig'), 'pub fn clash() void {}\n', 'utf8');
    fs.writeFileSync(path.join(fixtureRoot, 'ambiguous_b.zig'), 'pub fn clash() void {}\n', 'utf8');
    fs.writeFileSync(
      path.join(fixtureRoot, 'build.zig'),
      [
        'const std = @import("std");',
        'const build_support = @import("build_support.zig");',
        'pub fn build(b: *std.Build) void {',
        '    const target = b.standardTargetOptions(.{});',
        '    const optimize = b.standardOptimizeOption(.{});',
        '    const package_worker_mod = b.createModule(.{',
        '        .root_source_file = b.path("package_worker.zig"),',
        '        .target = target,',
        '        .optimize = optimize,',
        '    });',
        '    const app_mod = b.createModule(.{',
        '        .root_source_file = b.path("main.zig"),',
        '        .target = target,',
        '        .optimize = optimize,',
        '    });',
        '    app_mod.addImport("package_worker", package_worker_mod);',
        '    build_support.addPackage(b, target, optimize, app_mod);',
        '}',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(fixtureRoot, 'build_support.zig'),
      [
        'const std = @import("std");',
        'pub fn addPackage(',
        '    b: *std.Build,',
        '    target: std.Build.ResolvedTarget,',
        '    optimize: std.builtin.OptimizeMode,',
        '    app_mod: *std.Build.Module,',
        ') void {',
        '    const package_mod = b.createModule(.{',
        '        .root_source_file = b.path("package_root.zig"),',
        '        .target = target,',
        '        .optimize = optimize,',
        '    });',
        '    const ambiguous_a_mod = b.createModule(.{',
        '        .root_source_file = b.path("ambiguous_a.zig"),',
        '        .target = target,',
        '        .optimize = optimize,',
        '    });',
        '    const ambiguous_b_mod = b.createModule(.{',
        '        .root_source_file = b.path("ambiguous_b.zig"),',
        '        .target = target,',
        '        .optimize = optimize,',
        '    });',
        '    app_mod.addImport("package", package_mod);',
        '    app_mod.addImport("ambiguous", ambiguous_a_mod);',
        '    app_mod.addImport("ambiguous", ambiguous_b_mod);',
        '}',
      ].join('\n'),
      'utf8',
    );
    result = await runPipelineFromRepo(fixtureRoot, () => {});
  }, 60_000);

  afterAll(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('resolves a same-file free call', () => {
    const call = getRelationships(result, 'CALLS').find(
      (edge) => edge.source === 'main' && edge.target === 'localCheck',
    );
    expect(call).toBeDefined();
    expect(call?.targetFilePath).toBe('main.zig');
  });

  it('resolves an @import namespace member call', () => {
    const call = getRelationships(result, 'CALLS').find(
      (edge) => edge.source === 'main' && edge.target === 'run',
    );
    expect(call).toBeDefined();
    expect(call?.targetFilePath).toBe('worker.zig');
  });

  it('resolves a build.zig module member call', () => {
    const call = getRelationships(result, 'CALLS').find(
      (edge) => edge.source === 'main' && edge.target === 'execute',
    );
    expect(call).toBeDefined();
    expect(call?.targetFilePath).toBe('package_worker.zig');
  });

  it('resolves a build module through a Zig namespace re-export', () => {
    const call = getRelationships(result, 'CALLS').find(
      (edge) => edge.source === 'main' && edge.target === 'verify',
    );
    expect(call).toBeDefined();
    expect(call?.targetFilePath).toBe('nested.zig');
  });

  it('refuses an ambiguous build-module alias', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(
      calls.some(
        (edge) =>
          edge.sourceFilePath === 'main.zig' &&
          edge.target === 'clash' &&
          (edge.targetFilePath === 'ambiguous_a.zig' || edge.targetFilePath === 'ambiguous_b.zig'),
      ),
    ).toBe(false);
  });

  it('emits one local IMPORTS edge and leaves std unresolved', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const localTargets = imports
      .filter((edge) => edge.sourceFilePath === 'main.zig')
      .map((edge) => edge.targetFilePath)
      .sort();
    expect(localTargets).toEqual(['package_root.zig', 'package_worker.zig', 'worker.zig']);
    expect(imports.some((edge) => edge.targetFilePath.includes('std'))).toBe(false);
  });
});
