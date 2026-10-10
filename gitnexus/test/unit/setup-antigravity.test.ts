/** Regression: Antigravity setup is MCP + skills only; no lifecycle callbacks. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const packageVersion = (
  createRequire(import.meta.url)('../../package.json') as { version: string }
).version;

const mocks = vi.hoisted(() => ({
  execFileMock: vi.fn((...args: any[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function') callback(null, '', '');
  }),
  execFileSyncMock: vi.fn(() => {
    throw new Error('not found');
  }),
}));

vi.mock('child_process', () => ({
  execFile: mocks.execFileMock,
  execFileSync: mocks.execFileSyncMock,
}));

describe('setupAntigravity', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let platformDescriptor: PropertyDescriptor | undefined;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-antigravity-setup-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    await fs.mkdir(path.join(tempHome, '.gemini', 'antigravity'), { recursive: true });
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    delete process.env.GITNEXUS_TEST_SKILLS_ROOT;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('writes the MCP entry without creating callback settings or scripts', async () => {
    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(
      path.join(tempHome, '.gemini', 'antigravity', 'mcp_config.json'),
      'utf-8',
    );
    expect(JSON.parse(raw).mcpServers.gitnexus).toEqual({
      command: 'npx',
      args: ['-y', `gitnexus@${packageVersion}`, 'mcp'],
    });
    await expect(fs.access(path.join(tempHome, '.gemini', 'settings.json'))).rejects.toThrow();
    await expect(
      fs.access(path.join(tempHome, '.gemini', 'config', 'hooks', 'gitnexus')),
    ).rejects.toThrow();
  });

  it('preserves unrelated MCP configuration', async () => {
    const mcpPath = path.join(tempHome, '.gemini', 'antigravity', 'mcp_config.json');
    await fs.writeFile(
      mcpPath,
      JSON.stringify({ existingKey: 'keep', mcpServers: { other: { command: 'other' } } }),
      'utf-8',
    );

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const config = JSON.parse(await fs.readFile(mcpPath, 'utf-8'));
    expect(config.existingKey).toBe('keep');
    expect(config.mcpServers.other).toEqual({ command: 'other' });
    expect(config.mcpServers.gitnexus).toBeDefined();
  });

  it('installs skills without installing callbacks', async () => {
    const fixtureSkillsRoot = path.join(tempHome, 'fixture-skills');
    await fs.mkdir(fixtureSkillsRoot, { recursive: true });
    await fs.writeFile(
      path.join(fixtureSkillsRoot, 'gitnexus-test.md'),
      '---\nname: gitnexus-test\ndescription: fixture\n---\nbody\n',
      'utf-8',
    );
    process.env.GITNEXUS_TEST_SKILLS_ROOT = fixtureSkillsRoot;

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    await expect(
      fs.access(
        path.join(
          tempHome,
          '.gemini',
          'antigravity',
          'skills',
          'gitnexus-test',
          'SKILL.md',
        ),
      ),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(tempHome, '.gemini', 'settings.json'))).rejects.toThrow();
  });
});
