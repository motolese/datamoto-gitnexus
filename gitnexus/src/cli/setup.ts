/**
 * Setup Command
 *
 * One-time global MCP and skill configuration writer.
 * Detects installed AI editors and writes the appropriate MCP config
 * so the GitNexus MCP server is available in all projects. Lifecycle hooks
 * are deliberately not installed; indexing is an explicit command.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile, execFileSync } from 'child_process';
import { createRequire } from 'module';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { parseTree, modify, applyEdits, ParseError } from 'jsonc-parser';
import { getGlobalDir } from '../storage/repo-manager.js';
import { getEditorTargets, mcpTarget, skillTarget, detectIndentation } from './editor-targets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);

// Pin the npx fallback to the installed version. Reason: setup.ts writes
// a config that persists in the user's editor and is invoked on every MCP
// connect. Pinning to the installed version means subsequent invocations
// skip the npm-registry metadata roundtrip (and stay reproducible until
// the user upgrades). Static configs and READMEs intentionally use
// `gitnexus@latest` since they're quickstart docs, not persisted state.
const _require = createRequire(import.meta.url);
const _pkg = _require('../../package.json') as { version?: unknown };
if (typeof _pkg.version !== 'string' || !_pkg.version) {
  throw new Error(
    'gitnexus/package.json#version is missing or not a string — cannot generate MCP fallback config.',
  );
}
// Version-pinned ref for the persisted MCP entry. Generated documentation uses
// an explicit installed `gitnexus` command instead of an editor hook or copied
// wrapper.
const MCP_PINNED_REF = `gitnexus@${_pkg.version}`;

interface SetupResult {
  configured: string[];
  skipped: string[];
  errors: string[];
}

/**
 * Resolve the absolute path to the `gitnexus` binary if it's installed
 * globally (or via npm -g / yarn global). Returns null when not found.
 */
function resolveGitnexusBin(): string | null {
  try {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'where' : 'which';
    const output = execFileSync(cmd, ['gitnexus'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const lines = output
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    if (isWin) {
      // On Windows, npm global installs can surface multiple launchers for the
      // same package (e.g. a POSIX shell shim plus .cmd/.bat wrappers). Claude
      // and the other MCP hosts need a directly spawnable command path, so only
      // accept the Windows wrapper. If it is missing, fall back to the slower
      // npx entry instead of persisting a non-spawnable shim path.
      const cmdLine = lines.find((l) => /\.(cmd|bat)$/i.test(l));
      return cmdLine || null;
    }

    return lines[0] || null;
  } catch {
    return null;
  }
}

/**
 * The MCP server entry for all editors.
 *
 * Prefers the globally-installed `gitnexus` binary (starts in ~1 s) over
 * `npx -y gitnexus@<version>` (cold-cache install of native deps can take
 * >60 s, exceeding Claude Code's 30 s MCP connection timeout). The fallback
 * version is read from gitnexus/package.json#version at module load so the
 * persisted user config matches the installed package.
 *
 * Falls back to npx when the binary isn't on PATH — e.g. first-time
 * users who ran `npx gitnexus analyze` but haven't done `npm i -g`.
 */
function getMcpEntry() {
  const bin = resolveGitnexusBin();

  if (bin) {
    return { command: bin, args: ['mcp'] };
  }

  // Fallback: npx (works without a global install, but slow cold-start)
  if (process.platform === 'win32') {
    return {
      command: 'cmd',
      args: ['/c', 'npx', '-y', MCP_PINNED_REF, 'mcp'],
    };
  }
  return {
    command: 'npx',
    args: ['-y', MCP_PINNED_REF, 'mcp'],
  };
}

/**
 * OpenCode uses a different MCP format: { type: "local", command: [...] }
 * where command is a flat array (command + args combined).
 */
function getOpenCodeMcpEntry() {
  const bin = resolveGitnexusBin();

  if (bin) {
    return { type: 'local', command: [bin, 'mcp'] };
  }

  if (process.platform === 'win32') {
    return { type: 'local', command: ['cmd', '/c', 'npx', '-y', MCP_PINNED_REF, 'mcp'] };
  }
  return { type: 'local', command: ['npx', '-y', MCP_PINNED_REF, 'mcp'] };
}

/**
 * Merge a key/value pair into a JSONC config file, preserving comments and formatting.
 * If the file is genuinely corrupt (not valid JSONC), leaves it untouched.
 */
async function mergeJsoncFile(
  filePath: string,
  keyPath: string[],
  value: unknown,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    raw = '';
  }

  if (raw.trim().length === 0) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const formattingOptions = { tabSize: 2, insertSpaces: true };
    const edits = modify('{}', keyPath, value, { formattingOptions });
    const result = applyEdits('{}', edits);
    await fs.writeFile(filePath, result, 'utf-8');
    return true;
  }

  const parseErrors: ParseError[] = [];
  const tree = parseTree(raw, parseErrors);

  if (tree && tree.type === 'object' && parseErrors.length === 0) {
    const formattingOptions = detectIndentation(raw);
    const edits = modify(raw, keyPath, value, { formattingOptions });
    const result = applyEdits(raw, edits);
    await fs.writeFile(filePath, result, 'utf-8');
    return true;
  }

  return false;
}

/**
 * Check if a directory exists
 */
async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

// ─── Editor-specific setup ─────────────────────────────────────────

async function setupCursor(result: SetupResult): Promise<void> {
  const cursorDir = path.join(os.homedir(), '.cursor');
  if (!(await dirExists(cursorDir))) {
    result.skipped.push('Cursor (not installed)');
    return;
  }

  const { file: mcpPath, keyPath } = mcpTarget('cursor');
  try {
    const ok = await mergeJsoncFile(mcpPath, keyPath, getMcpEntry());
    if (ok) {
      result.configured.push('Cursor');
    } else {
      result.errors.push('Cursor: mcp.json is corrupt — skipping to preserve existing content');
    }
  } catch (err: any) {
    result.errors.push(`Cursor: ${err.message}`);
  }
}

async function setupClaudeCode(result: SetupResult): Promise<void> {
  const claudeDir = path.join(os.homedir(), '.claude');
  if (!(await dirExists(claudeDir))) {
    result.skipped.push('Claude Code (not installed)');
    return;
  }

  // Claude Code stores MCP config in ~/.claude.json
  const { file: mcpPath, keyPath } = mcpTarget('claude');
  try {
    const ok = await mergeJsoncFile(mcpPath, keyPath, getMcpEntry());
    if (ok) {
      result.configured.push('Claude Code');
    } else {
      result.errors.push(
        'Claude Code: .claude.json is corrupt — skipping to preserve existing content',
      );
    }
  } catch (err: any) {
    result.errors.push(`Claude Code: ${err.message}`);
  }
}

/**
 * Install GitNexus skills.
 *
 * Per project policy 2026-05-16 (bitcoinize-alpha mandate): `.agents/` is the
 * canonical cross-CLI skill directory. Skills NEVER auto-install to
 * `~/.claude/skills/` if the CWD has an `.agents/` directory — that path
 * pollutes every Claude Code session for every project on the machine.
 *
 * Resolution order:
 *   1. `<cwd>/.agents/skills/gitnexus/` if the project has `.agents/` (preferred)
 *   2. `skillTarget('claude').dir` (standard per-CLI location)
 */
async function installClaudeCodeSkills(result: SetupResult): Promise<void> {
  const claudeDir = path.join(os.homedir(), '.claude');
  if (!(await dirExists(claudeDir))) return;

  const projectAgentsDir = path.join(process.cwd(), '.agents');
  if (await dirExists(projectAgentsDir)) {
    const projectSkillsDir = path.join(projectAgentsDir, 'skills', 'gitnexus');
    try {
      const installed = await installSkillsTo(projectSkillsDir);
      if (installed.length > 0) {
        result.configured.push(
          `Claude Code skills (${installed.length} skills → ${path.relative(process.cwd(), projectSkillsDir) || projectSkillsDir})`,
        );
      }
    } catch (err: any) {
      result.errors.push(`Claude Code skills (project .agents/): ${err.message}`);
    }
    return;
  }

  const skillsDir = skillTarget('claude').dir;
  try {
    const installed = await installSkillsTo(skillsDir);
    if (installed.length > 0) {
      result.configured.push(`Claude Code skills (${installed.length} skills → ~/.claude/skills/)`);
    }
  } catch (err: any) {
    result.errors.push(`Claude Code skills: ${err.message}`);
  }
}

// ─── Antigravity (Google) ──────────────────────────────────────────
//
// Antigravity stores its MCP config under ~/.gemini/antigravity/mcp_config.json
// and receives GitNexus only through that explicit MCP endpoint plus installed
// skills. Setup never registers lifecycle callbacks.

async function setupAntigravity(result: SetupResult): Promise<void> {
  const antigravityDir = path.join(os.homedir(), '.gemini', 'antigravity');
  if (!(await dirExists(antigravityDir))) {
    result.skipped.push('Antigravity (not installed)');
    return;
  }

  const { file: mcpPath, keyPath } = mcpTarget('antigravity');
  try {
    const ok = await mergeJsoncFile(mcpPath, keyPath, getMcpEntry());
    if (ok) {
      result.configured.push('Antigravity');
    } else {
      result.errors.push(
        'Antigravity: mcp_config.json is corrupt — skipping to preserve existing content',
      );
    }
  } catch (err: any) {
    result.errors.push(`Antigravity: ${err.message}`);
  }
}

/**
 * Install GitNexus skills to ~/.gemini/antigravity/skills/ (global scope,
 * per https://codelabs.developers.google.com/getting-started-with-antigravity-skills).
 * Each skill is laid out as {skillName}/SKILL.md just like the other editors.
 */
async function installAntigravitySkills(result: SetupResult): Promise<void> {
  const antigravityDir = path.join(os.homedir(), '.gemini', 'antigravity');
  if (!(await dirExists(antigravityDir))) return;

  const skillsDir = skillTarget('antigravity').dir;
  try {
    const installed = await installSkillsTo(skillsDir);
    if (installed.length > 0) {
      result.configured.push(
        `Antigravity skills (${installed.length} skills → ~/.gemini/antigravity/skills/)`,
      );
    }
  } catch (err: any) {
    result.errors.push(`Antigravity skills: ${err.message}`);
  }
}

async function setupOpenCode(result: SetupResult): Promise<void> {
  const opencodeDir = path.join(os.homedir(), '.config', 'opencode');
  if (!(await dirExists(opencodeDir))) {
    result.skipped.push('OpenCode (not installed)');
    return;
  }

  const { file: configPath, keyPath } = mcpTarget('opencode');
  try {
    const ok = await mergeJsoncFile(configPath, keyPath, getOpenCodeMcpEntry());
    if (ok) {
      result.configured.push('OpenCode');
    } else {
      result.errors.push(
        'OpenCode: opencode.json is corrupt — skipping to preserve existing content',
      );
    }
  } catch (err: any) {
    result.errors.push(`OpenCode: ${err.message}`);
  }
}

/**
 * Build a TOML section for Codex MCP config (~/.codex/config.toml).
 */
function getCodexMcpTomlSection(): string {
  const entry = getMcpEntry();
  const command = JSON.stringify(entry.command);
  const args = `[${entry.args.map((arg) => JSON.stringify(arg)).join(', ')}]`;
  return `[${getEditorTargets().codex.tomlSection}]\ncommand = ${command}\nargs = ${args}\n`;
}

/**
 * Append GitNexus MCP server config to Codex's config.toml if missing.
 */
async function upsertCodexConfigToml(configPath: string): Promise<void> {
  let existing = '';
  try {
    existing = await fs.readFile(configPath, 'utf-8');
  } catch {
    existing = '';
  }

  if (existing.includes(`[${getEditorTargets().codex.tomlSection}]`)) {
    return;
  }

  const section = getCodexMcpTomlSection();
  const nextContent = existing.trim().length > 0 ? `${existing.trimEnd()}\n\n${section}` : section;

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${nextContent.trimEnd()}\n`, 'utf-8');
}

async function setupCodex(result: SetupResult): Promise<void> {
  const codexDir = path.join(os.homedir(), '.codex');
  if (!(await dirExists(codexDir))) {
    result.skipped.push('Codex (not installed)');
    return;
  }

  try {
    const entry = getMcpEntry();
    await execFileAsync('codex', ['mcp', 'add', 'gitnexus', '--', entry.command, ...entry.args], {
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    result.configured.push('Codex');
    return;
  } catch {
    // Fallback for environments where `codex` binary isn't on PATH.
  }

  try {
    const configPath = getEditorTargets().codex.configFile;
    await upsertCodexConfigToml(configPath);
    result.configured.push('Codex (MCP added to ~/.codex/config.toml)');
  } catch (err: any) {
    result.errors.push(`Codex: ${err.message}`);
  }
}

// ─── Skill Installation ───────────────────────────────────────────

/**
 * Install GitNexus skills to a target directory.
 * Each skill is installed as {targetDir}/gitnexus-{skillName}/SKILL.md
 * following the Agent Skills standard (Cursor, Claude Code, and Codex).
 *
 * Supports two source layouts:
 *   - Flat file:  skills/{name}.md           → copied as SKILL.md
 *   - Directory:  skills/{name}/SKILL.md     → copied recursively (includes references/, etc.)
 */
async function installSkillsTo(targetDir: string): Promise<string[]> {
  const installed: string[] = [];
  // GITNEXUS_TEST_SKILLS_ROOT lets tests stage a fixture skills tree without
  // depending on __dirname resolution under Vitest.
  const skillsRoot =
    process.env.GITNEXUS_TEST_SKILLS_ROOT ?? path.join(__dirname, '..', '..', 'skills');

  // Was glob('*.md') + glob('*/SKILL.md'); replaced with fs.readdir because
  // glob v13's cwd handling did not match the fixture path on Windows runners
  // (absolute temp paths containing the 8.3 short-name `RUNNER~1` returned
  // zero matches). fs.readdir has no such path quirks.
  let flatFiles: string[] = [];
  let dirSkillFiles: string[] = [];
  try {
    const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
    flatFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name);
    const subdirSkillFiles = await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          try {
            await fs.access(path.join(skillsRoot, e.name, 'SKILL.md'));
            return path.join(e.name, 'SKILL.md');
          } catch {
            return null;
          }
        }),
    );
    dirSkillFiles = subdirSkillFiles.filter((p): p is string => p !== null);
  } catch {
    return [];
  }

  const skillSources = new Map<string, { isDirectory: boolean }>();

  for (const relPath of dirSkillFiles) {
    skillSources.set(path.dirname(relPath), { isDirectory: true });
  }
  for (const relPath of flatFiles) {
    const skillName = path.basename(relPath, '.md');
    if (!skillSources.has(skillName)) {
      skillSources.set(skillName, { isDirectory: false });
    }
  }

  for (const [skillName, source] of skillSources) {
    const skillDir = path.join(targetDir, skillName);

    try {
      if (source.isDirectory) {
        const dirSource = path.join(skillsRoot, skillName);
        await copyDirRecursive(dirSource, skillDir);
        installed.push(skillName);
      } else {
        const flatSource = path.join(skillsRoot, `${skillName}.md`);
        const content = await fs.readFile(flatSource, 'utf-8');
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(path.join(skillDir, 'SKILL.md'), content, 'utf-8');
        installed.push(skillName);
      }
    } catch {
      // Source skill not found — skip
    }
  }

  return installed;
}

/**
 * Recursively copy a directory tree.
 */
async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Install global Cursor skills to ~/.cursor/skills/gitnexus/
 */
async function installCursorSkills(result: SetupResult): Promise<void> {
  const cursorDir = path.join(os.homedir(), '.cursor');
  if (!(await dirExists(cursorDir))) return;

  const skillsDir = skillTarget('cursor').dir;
  try {
    const installed = await installSkillsTo(skillsDir);
    if (installed.length > 0) {
      result.configured.push(`Cursor skills (${installed.length} skills → ~/.cursor/skills/)`);
    }
  } catch (err: any) {
    result.errors.push(`Cursor skills: ${err.message}`);
  }
}

/**
 * Install global OpenCode skills to ~/.config/opencode/skills/gitnexus/
 */
async function installOpenCodeSkills(result: SetupResult): Promise<void> {
  const opencodeDir = path.join(os.homedir(), '.config', 'opencode');
  if (!(await dirExists(opencodeDir))) return;

  const skillsDir = skillTarget('opencode').dir;
  try {
    const installed = await installSkillsTo(skillsDir);
    if (installed.length > 0) {
      result.configured.push(
        `OpenCode skills (${installed.length} skills → ~/.config/opencode/skills/)`,
      );
    }
  } catch (err: any) {
    result.errors.push(`OpenCode skills: ${err.message}`);
  }
}

/**
 * Install global Codex skills to ~/.agents/skills/gitnexus/
 */
async function installCodexSkills(result: SetupResult): Promise<void> {
  const codexDir = path.join(os.homedir(), '.codex');
  if (!(await dirExists(codexDir))) return;

  const skillsDir = skillTarget('codex').dir;
  try {
    const installed = await installSkillsTo(skillsDir);
    if (installed.length > 0) {
      result.configured.push(`Codex skills (${installed.length} skills → ~/.agents/skills/)`);
    }
  } catch (err: any) {
    result.errors.push(`Codex skills: ${err.message}`);
  }
}

// ─── Main command ──────────────────────────────────────────────────

export const setupCommand = async () => {
  console.log('');
  console.log('  GitNexus Setup');
  console.log('  ==============');
  console.log('');

  // Ensure global directory exists
  const globalDir = getGlobalDir();
  await fs.mkdir(globalDir, { recursive: true });

  const result: SetupResult = {
    configured: [],
    skipped: [],
    errors: [],
  };

  // Detect and configure each editor's MCP
  await setupCursor(result);
  await setupClaudeCode(result);
  await setupAntigravity(result);
  await setupOpenCode(result);
  await setupCodex(result);

  // Install global skills for platforms that support them
  await installClaudeCodeSkills(result);
  await installAntigravitySkills(result);
  await installCursorSkills(result);
  await installOpenCodeSkills(result);
  await installCodexSkills(result);
  result.skipped.push('Lifecycle hooks (disabled; run gitnexus analyze explicitly)');

  // Print results
  if (result.configured.length > 0) {
    console.log('  Configured:');
    for (const name of result.configured) {
      console.log(`    + ${name}`);
    }
  }

  if (result.skipped.length > 0) {
    console.log('');
    console.log('  Skipped:');
    for (const name of result.skipped) {
      console.log(`    - ${name}`);
    }
  }

  if (result.errors.length > 0) {
    console.log('');
    console.log('  Errors:');
    for (const err of result.errors) {
      console.log(`    ! ${err}`);
    }
  }

  console.log('');
  console.log('  Summary:');
  console.log(
    `    MCP configured for: ${result.configured.filter((c) => !c.includes('skills')).join(', ') || 'none'}`,
  );
  console.log(
    `    Skills installed to: ${result.configured.filter((c) => c.includes('skills')).length > 0 ? result.configured.filter((c) => c.includes('skills')).join(', ') : 'none'}`,
  );
  console.log('');
  console.log('  Next steps:');
  console.log('    1. cd into any git repo');
  console.log('    2. Run: gitnexus analyze');
  console.log('    3. Open the repo in your editor — MCP is ready!');
  console.log('');
};
