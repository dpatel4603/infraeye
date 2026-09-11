import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const output = mkdtempSync(join(tmpdir(), 'infraeye-tests-'));
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', 'src/interpretation.ts', '--outDir', output, '--module', 'commonjs', '--target', 'ES2022', '--skipLibCheck']);
const { meaningful, plainChange, routePatterns } = createRequire(import.meta.url)(join(output, 'interpretation.js'));
after(() => rmSync(output, { recursive: true, force: true }));
const route = (peer, path, extra = {}) => ({ id: 1, timestamp: 10, type: 'announcement', peer_id: peer, prefix: '1.1.1.0/24', as_path: path, ...extra });
test('unchanged announcements and repeated withdrawals do not crowd important events', () => {
 assert.equal(meaningful(route('a', [1, 2], { previous_path: [1, 2] })), false);
 assert.equal(meaningful(route('a', [], { type: 'withdrawal', previous_path: null })), false);
 assert.equal(meaningful(route('a', [], { type: 'withdrawal', previous_path: [1, 2] })), true);
 assert.equal(plainChange(route('a', [], { type: 'withdrawal', previous_path: [1, 2] })), 'Stopped reporting a route');
});
test('new routes, path replacement and prepending changes remain important', () => {
 assert.equal(meaningful(route('a', [1, 2])), true);
 assert.equal(meaningful(route('a', [1, 3, 2], { previous_path: [1, 2] })), true);
 assert.equal(meaningful(route('a', [1, 2, 2], { previous_path: [1, 2] })), true);
});
test('patterns combine observers with the same suffix without losing intermediate networks', () => {
 const input = [route('a', [1, 174, 13335]), route('b', [2, 174, 13335]), route('c', [3, 327727, 174, 13335]), route('d', [4, 13335])];
 const result = routePatterns(input);
 assert.equal(result.length, 3);
 assert.equal(result[0].routes.length, 2);
 assert.deepEqual(result[0].via, [174, 13335]);
 assert.ok(result.some(p => p.via.join(',') === '327727,174,13335'));
 assert.deepEqual(input[0].as_path, [1, 174, 13335]);
});
test('different prefixes and origins remain distinct patterns', () => {
 assert.equal(routePatterns([route('a', [1, 2]), route('b', [3, 2], {prefix:'8.8.8.0/24'}), route('c', [4, 5])]).length, 3);
});
