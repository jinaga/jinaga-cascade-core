import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const packageRoot = resolve(process.cwd());
const scratchDir = mkdtempSync(join(tmpdir(), 'cascade-core-smoke-'));
let tarballPath;

try {
    const packOutput = execFileSync('npm', ['pack', '--silent'], {
        cwd: packageRoot,
        encoding: 'utf8'
    }).trim();

    const tarballName = packOutput.split('\n').filter(Boolean).at(-1);
    if (!tarballName) {
        throw new Error('npm pack did not produce a tarball name.');
    }

    tarballPath = join(packageRoot, tarballName);

    writeFileSync(
        join(scratchDir, 'package.json'),
        JSON.stringify({
            name: 'cascade-core-smoke-project',
            private: true,
            type: 'module'
        }, null, 2)
    );

    execFileSync('npm', ['install', '--silent', tarballPath], {
        cwd: scratchDir,
        stdio: 'inherit'
    });

    execFileSync(
        'node',
        [
            '--input-type=module',
            '--eval',
            "await import('@jinaga/cascade-core');"
        ],
        {
            cwd: scratchDir,
            stdio: 'inherit'
        }
    );

    console.log('Node ESM smoke test passed.');
} finally {
    if (tarballPath) {
        rmSync(tarballPath, { force: true });
    }
    rmSync(scratchDir, { recursive: true, force: true });
}
