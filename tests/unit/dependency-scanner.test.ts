import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DependencyScanner } from '../../src/scanner/dependencies/DependencyScanner.js';

describe('DependencyScanner', () => {
  let tempBaseDir: string;
  let standardProjectDir: string;
  let noManifestDir: string;
  let malformedJsonDir: string;
  let invalidSectionsDir: string;
  let filePath: string;
  let symlinkProjectDir: string;
  let outsideTargetDir: string;
  let nodeModulesSymlinkDir: string;

  beforeAll(async () => {
    tempBaseDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dj-dep-test-'));

    // 1. Standard project fixture with all dependency types, lockfile, and installed node_modules
    standardProjectDir = path.join(tempBaseDir, 'standard-project');
    await fs.promises.mkdir(standardProjectDir, { recursive: true });

    const packageJsonContent = {
      name: 'test-app',
      version: '1.0.0',
      dependencies: {
        express: '^5.0.0',
        shared: '^1.0.0', // to test duplicates across sections
      },
      devDependencies: {
        typescript: '^5.7.0',
        vitest: '^3.0.0',
      },
      optionalDependencies: {
        fsevents: '^2.3.3',
      },
      peerDependencies: {
        shared: '>=1.0.0', // duplicate declaration preserved
        react: '^19.0.0',
      },
    };

    await fs.promises.writeFile(
      path.join(standardProjectDir, 'package.json'),
      JSON.stringify(packageJsonContent, null, 2),
    );

    // Mock package-lock.json presence
    await fs.promises.writeFile(
      path.join(standardProjectDir, 'package-lock.json'),
      '{"name":"test-app","lockfileVersion":3}',
    );

    // Setup node_modules with regular and scoped packages
    const nmDir = path.join(standardProjectDir, 'node_modules');
    const expressDir = path.join(nmDir, 'express');
    const scopedDir = path.join(nmDir, '@scope', 'pkg-a');

    await fs.promises.mkdir(expressDir, { recursive: true });
    await fs.promises.mkdir(scopedDir, { recursive: true });

    await fs.promises.writeFile(
      path.join(expressDir, 'package.json'),
      JSON.stringify({ name: 'express', version: '5.1.0' }),
    );
    await fs.promises.writeFile(
      path.join(scopedDir, 'package.json'),
      JSON.stringify({ name: '@scope/pkg-a', version: '2.0.0' }),
    );

    // Create an external directory and link a symlinked package inside node_modules
    outsideTargetDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dj-dep-outside-'));
    await fs.promises.writeFile(
      path.join(outsideTargetDir, 'package.json'),
      JSON.stringify({ name: 'outside-pkg', version: '9.9.9' }),
    );

    try {
      await fs.promises.symlink(outsideTargetDir, path.join(nmDir, 'symlinked-pkg'), 'dir');
    } catch {
      // Ignore if symlink not permitted
    }

    // 2. Project with symlinked node_modules
    nodeModulesSymlinkDir = path.join(tempBaseDir, 'node-modules-symlink-project');
    await fs.promises.mkdir(nodeModulesSymlinkDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(nodeModulesSymlinkDir, 'package.json'),
      JSON.stringify({ name: 'symlink-nm-app' }),
    );
    try {
      await fs.promises.symlink(nmDir, path.join(nodeModulesSymlinkDir, 'node_modules'), 'dir');
    } catch {
      // Ignore if symlink not permitted
    }

    // 3. Project without manifest
    noManifestDir = path.join(tempBaseDir, 'no-manifest');
    await fs.promises.mkdir(noManifestDir, { recursive: true });

    // 4. Malformed package.json
    malformedJsonDir = path.join(tempBaseDir, 'malformed-json');
    await fs.promises.mkdir(malformedJsonDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(malformedJsonDir, 'package.json'),
      '{ invalid json here ,,, }',
    );

    // 5. Invalid dependency section types
    invalidSectionsDir = path.join(tempBaseDir, 'invalid-sections');
    await fs.promises.mkdir(invalidSectionsDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(invalidSectionsDir, 'package.json'),
      JSON.stringify({
        name: 'invalid-sections-app',
        dependencies: 'not-an-object',
        devDependencies: null,
        peerDependencies: [1, 2, 3],
      }),
    );

    // 6. Regular file as root
    filePath = path.join(tempBaseDir, 'regular-file.txt');
    await fs.promises.writeFile(filePath, 'plain text');

    // 7. Symlinked rootPath
    symlinkProjectDir = path.join(tempBaseDir, 'symlink-project');
    try {
      await fs.promises.symlink(standardProjectDir, symlinkProjectDir, 'dir');
    } catch {
      // Ignore if symlink not permitted
    }
  });

  afterAll(async () => {
    try {
      await fs.promises.rm(tempBaseDir, { recursive: true, force: true });
      await fs.promises.rm(outsideTargetDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it('1. detects package.json and parses declarations correctly', async () => {
    const scanner = new DependencyScanner();
    const result = await scanner.scan({ rootPath: standardProjectDir });

    expect(result.manifestFound).toBe(true);
    expect(result.manifestType).toBe('package.json');
    expect(result.rootPath).toBe(path.resolve(standardProjectDir));
  });

  it('2. parses production dependencies', async () => {
    const scanner = new DependencyScanner();
    const result = await scanner.scan({ rootPath: standardProjectDir });

    const prodDeps = result.dependencies.filter((d) => d.dependencyType === 'production');
    expect(prodDeps.map((d) => d.name)).toContain('express');
    const expressDep = prodDeps.find((d) => d.name === 'express');
    expect(expressDep?.requestedVersion).toBe('^5.0.0');
  });

  it('3. parses development dependencies', async () => {
    const scanner = new DependencyScanner();
    const result = await scanner.scan({ rootPath: standardProjectDir });

    const devDeps = result.dependencies.filter((d) => d.dependencyType === 'development');
    expect(devDeps.map((d) => d.name)).toContain('typescript');
    expect(devDeps.map((d) => d.name)).toContain('vitest');
  });

  it('4. parses optional dependencies', async () => {
    const scanner = new DependencyScanner();
    const result = await scanner.scan({ rootPath: standardProjectDir });

    const optDeps = result.dependencies.filter((d) => d.dependencyType === 'optional');
    expect(optDeps.map((d) => d.name)).toContain('fsevents');
    expect(optDeps[0].requestedVersion).toBe('^2.3.3');
  });

  it('5. parses peer dependencies', async () => {
    const scanner = new DependencyScanner();
    const result = await scanner.scan({ rootPath: standardProjectDir });

    const peerDeps = result.dependencies.filter((d) => d.dependencyType === 'peer');
    expect(peerDeps.map((d) => d.name)).toContain('react');
    expect(peerDeps.find((d) => d.name === 'react')?.requestedVersion).toBe('^19.0.0');
  });

  it('6. preserves duplicate package declarations across dependency sections', async () => {
    const scanner = new DependencyScanner();
    const result = await scanner.scan({ rootPath: standardProjectDir });

    const sharedDeclarations = result.dependencies.filter((d) => d.name === 'shared');
    expect(sharedDeclarations.length).toBe(2);
    expect(sharedDeclarations.some((d) => d.dependencyType === 'production')).toBe(true);
    expect(sharedDeclarations.some((d) => d.dependencyType === 'peer')).toBe(true);
  });

  it('7 & 8. detects installed node_modules packages and reads name/version', async () => {
    const scanner = new DependencyScanner();
    const result = await scanner.scan({ rootPath: standardProjectDir });

    expect(result.nodeModulesPresent).toBe(true);
    expect(result.totalInstalledDependencies).toBeGreaterThanOrEqual(2);

    const expressInstalled = result.installedDependencies.find((p) => p.name === 'express');
    expect(expressInstalled).toBeDefined();
    expect(expressInstalled?.version).toBe('5.1.0');
    expect(expressInstalled?.path).toBe(
      path.join(path.resolve(standardProjectDir), 'node_modules', 'express'),
    );
  });

  it('9. supports scoped packages in node_modules', async () => {
    const scanner = new DependencyScanner();
    const result = await scanner.scan({ rootPath: standardProjectDir });

    const scopedInstalled = result.installedDependencies.find((p) => p.name === '@scope/pkg-a');
    expect(scopedInstalled).toBeDefined();
    expect(scopedInstalled?.version).toBe('2.0.0');
  });

  it('10. does not follow node_modules symlink', async () => {
    const scanner = new DependencyScanner();
    const result = await scanner.scan({ rootPath: nodeModulesSymlinkDir });

    // Since node_modules in nodeModulesSymlinkDir is a symlink, it must not be treated as a real directory
    expect(result.nodeModulesPresent).toBe(false);
    expect(result.installedDependencies).toHaveLength(0);
  });

  it('11. does not follow package symlink in node_modules', async () => {
    const scanner = new DependencyScanner();
    const result = await scanner.scan({ rootPath: standardProjectDir });

    const outsidePkg = result.installedDependencies.find((p) => p.name === 'outside-pkg');
    expect(outsidePkg).toBeUndefined();
  });

  it('12. rejects rootPath if it is a symbolic link', async () => {
    const scanner = new DependencyScanner();
    try {
      await expect(scanner.scan({ rootPath: symlinkProjectDir })).rejects.toThrow(
        'Root path cannot be a symbolic link',
      );
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') {
        return;
      }
      throw err;
    }
  });

  it('13. rejects nonexistent root', async () => {
    const scanner = new DependencyScanner();
    const fakePath = path.join(tempBaseDir, 'nonexistent-project');
    await expect(scanner.scan({ rootPath: fakePath })).rejects.toThrow('Path does not exist');
  });

  it('14. rejects file as root', async () => {
    const scanner = new DependencyScanner();
    await expect(scanner.scan({ rootPath: filePath })).rejects.toThrow('Path is not a directory');
  });

  it('15. rejects empty rootPath', async () => {
    const scanner = new DependencyScanner();
    await expect(scanner.scan({ rootPath: '' })).rejects.toThrow('non-empty string');
    await expect(scanner.scan({ rootPath: '   ' })).rejects.toThrow('non-empty string');
  });

  it('16. handles malformed package.json with clear error', async () => {
    const scanner = new DependencyScanner();
    await expect(scanner.scan({ rootPath: malformedJsonDir })).rejects.toThrow(
      'Failed to parse package.json',
    );
  });

  it('17 & 18. handles missing or invalid dependency section types safely', async () => {
    const scanner = new DependencyScanner();
    const result = await scanner.scan({ rootPath: invalidSectionsDir });

    expect(result.manifestFound).toBe(true);
    expect(result.dependencies).toHaveLength(0);
    expect(result.totalDependencies).toBe(0);
  });

  it('19a. maxDependencies limits declared dependencies only and does not prevent installed package scanning', async () => {
    const scanner = new DependencyScanner();
    const result = await scanner.scan({
      rootPath: standardProjectDir,
      maxDependencies: 2,
      maxInstalledDependencies: 10,
    });

    expect(result.dependencies).toHaveLength(2);
    expect(result.totalDependencies).toBe(2);
    // Installed dependencies are not constrained by maxDependencies
    expect(result.installedDependencies.length).toBeGreaterThanOrEqual(2);
    expect(result.truncated).toBe(true);
  });

  it('19b. maxInstalledDependencies limits installed packages only and does not prevent declared dependency scanning', async () => {
    const scanner = new DependencyScanner();
    const result = await scanner.scan({
      rootPath: standardProjectDir,
      maxDependencies: 10,
      maxInstalledDependencies: 1,
    });

    // Declared dependencies are fully discovered despite installed package limit
    expect(result.dependencies.length).toBeGreaterThanOrEqual(6);
    expect(result.installedDependencies).toHaveLength(1);
    expect(result.totalInstalledDependencies).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('19c. when neither limit is reached, truncated is false', async () => {
    const scanner = new DependencyScanner();
    const result = await scanner.scan({
      rootPath: standardProjectDir,
      maxDependencies: 50,
      maxInstalledDependencies: 50,
    });

    expect(result.dependencies.length).toBeGreaterThanOrEqual(6);
    expect(result.installedDependencies.length).toBeGreaterThanOrEqual(2);
    expect(result.truncated).toBe(false);
  });

  it('19d. rejects invalid limit parameters', async () => {
    const scanner = new DependencyScanner();
    await expect(
      scanner.scan({ rootPath: standardProjectDir, maxDependencies: 0 }),
    ).rejects.toThrow('positive integer');
    await expect(
      scanner.scan({ rootPath: standardProjectDir, maxInstalledDependencies: -1 }),
    ).rejects.toThrow('positive integer');
  });

  it('20. returns no-manifest result when package.json is absent', async () => {
    const scanner = new DependencyScanner();
    const result = await scanner.scan({ rootPath: noManifestDir });

    expect(result.manifestFound).toBe(false);
    expect(result.manifestType).toBeNull();
    expect(result.dependencies).toHaveLength(0);
    expect(result.installedDependencies).toHaveLength(0);
    expect(result.totalDependencies).toBe(0);
    expect(result.totalInstalledDependencies).toBe(0);
    expect(result.nodeModulesPresent).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('21. detects lockfile presence without parsing lockfile contents', async () => {
    const scanner = new DependencyScanner();
    const result = await scanner.scan({ rootPath: standardProjectDir });

    expect(result.lockfileDetected).toBe('package-lock.json');
  });

  it('22. guarantees read-only behavior: scanner does not modify fixture files or metadata', async () => {
    const pkgJsonPath = path.join(standardProjectDir, 'package.json');
    const statBefore = await fs.promises.lstat(pkgJsonPath);
    const contentBefore = await fs.promises.readFile(pkgJsonPath, 'utf-8');

    const scanner = new DependencyScanner();
    await scanner.scan({ rootPath: standardProjectDir });

    const statAfter = await fs.promises.lstat(pkgJsonPath);
    const contentAfter = await fs.promises.readFile(pkgJsonPath, 'utf-8');

    expect(contentAfter).toBe(contentBefore);
    expect(statAfter.size).toBe(statBefore.size);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
  });
});
