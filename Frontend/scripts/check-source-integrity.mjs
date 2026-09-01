/**
 * Refuse to build source that looks like it has had code injected into it.
 *
 * Three times now an obfuscated build-time payload has been appended to
 * vite.config.js: one enormous single line, pushed off screen by a wall of
 * whitespace after the closing `});`, committed under a real author's name.
 * It is build-time code, so it targets exactly this moment -- the config is
 * evaluated by `vite build`, on whatever machine runs the build.
 *
 * Two signals, both cheap and both specific to how that payload hides:
 *
 *  1. A source line far longer than any hand-written line. Minified vendor
 *     code lives in node_modules and dist, which are not scanned.
 *  2. A long run of trailing whitespace, which is how the payload is pushed
 *     out of sight in an editor.
 *
 * This is a tripwire, not a scanner: it catches this family cheaply and says
 * plainly what to do. It cannot prove a tree is clean.
 *
 *   node scripts/check-source-integrity.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Hand-written source stays well under this. Long data URIs are the one honest
// exception, so they are allowed explicitly rather than by raising the limit.
const MAX_LINE = 5000;
const MAX_TRAILING_WHITESPACE = 40;
const SCAN_EXTENSIONS = /\.(m?[jt]sx?|c?[jt]s|json|html)$/;
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.git', 'build', 'coverage']);

const findings = [];

const scanFile = (path) => {
    let text;
    try {
        text = readFileSync(path, 'utf8');
    } catch {
        return; // unreadable or binary; nothing to judge
    }

    const shown = relative(root, path).split(sep).join('/');

    text.split('\n').forEach((line, index) => {
        const withoutTrailing = line.replace(/\s+$/, '');
        // Only whitespace that FOLLOWS real code counts. A blank line carrying
        // its block's indentation is ordinary formatting -- deeply nested JSX
        // is full of them -- whereas the payload hides itself after `});`.
        const trailing = withoutTrailing.length === 0
            ? 0
            : line.length - withoutTrailing.length;

        if (line.length > MAX_LINE && !line.includes('data:')) {
            findings.push(`${shown}:${index + 1} — single line of ${line.length} characters`);
        } else if (trailing > MAX_TRAILING_WHITESPACE) {
            findings.push(`${shown}:${index + 1} — ${trailing} characters of trailing whitespace`);
        }
    });
};

const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
        if (SKIP_DIRECTORIES.has(entry)) continue;
        const full = join(dir, entry);
        let info;
        try {
            info = statSync(full);
        } catch {
            continue;
        }
        if (info.isDirectory()) walk(full);
        else if (SCAN_EXTENSIONS.test(entry)) scanFile(full);
    }
};

walk(root);

if (findings.length > 0) {
    console.error('\n[integrity] Build stopped: source looks tampered with.\n');
    for (const finding of findings) console.error(`  ${finding}`);
    console.error(
        '\n  An obfuscated payload has been appended to this project three times,'
        + '\n  always as one very long line hidden behind trailing whitespace.'
        + '\n  Inspect the lines above before building. If one is legitimate,'
        + '\n  reformat it rather than raising the threshold.\n'
    );
    process.exit(1);
}

console.log('[integrity] no injected-code signatures found');
