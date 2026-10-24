#!/usr/bin/env node
/**
 * webhook-server.js 的鉴权回归测试。
 *
 * 覆盖三条曾经失守的边界：
 * 1. 未配置密钥时必须拒绝（旧实现是 fail-open，任何 POST 都能触发部署）；
 * 2. 签名头缺失/畸形时不得抛异常，也不得放行；
 * 3. 请求体必须有上限（旧实现无界读取）。
 *
 * 只用 ping 事件验证放行路径，不会执行 deploy()，因此无需 Docker。
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverScript = path.join(repoRoot, 'scripts/deploy/webhook-server.js');
const logDir = path.join(repoRoot, 'dist', 'webhook-security-test');
const port = 19000 + Math.floor(Math.random() * 500);

fs.mkdirSync(logDir, { recursive: true });

function start(secret) {
  const child = spawn(process.execPath, [serverScript], {
    env: { ...process.env, WEBHOOK_SECRET: secret, WEBHOOK_PORT: String(port), PROJECT_DIR: logDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('webhook server did not start')), 5000);
    child.stdout.on('data', (data) => {
      if (String(data).includes('listening')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`webhook server exited early with code ${code}`));
    });
  });
}

function post(body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/webhook', method: 'POST', headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function sign(secret, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

const results = [];
function check(name, actual, expected) {
  const ok = actual === expected;
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} (got ${actual}, want ${expected})`);
}

const pushBody = JSON.stringify({ ref: 'refs/heads/main', commits: [] });
const strongSecret = crypto.randomBytes(32).toString('hex');

let child = await start('');
check('missing secret is refused', (await post(pushBody, { 'x-github-event': 'push' })).status, 503);
child.kill();

child = await start('your_secret_here_change_me');
check(
  'placeholder secret is refused',
  (await post(pushBody, { 'x-github-event': 'push', 'x-hub-signature-256': sign('your_secret_here_change_me', pushBody) }))
    .status,
  503
);
child.kill();

child = await start('short');
check(
  'short secret is refused',
  (await post(pushBody, { 'x-github-event': 'push', 'x-hub-signature-256': sign('short', pushBody) })).status,
  503
);
child.kill();

child = await start(strongSecret);
check(
  'wrong signature is rejected',
  (await post(pushBody, { 'x-github-event': 'push', 'x-hub-signature-256': `sha256=${'a'.repeat(64)}` })).status,
  401
);
check('missing signature header is rejected', (await post(pushBody, { 'x-github-event': 'push' })).status, 401);
check(
  'malformed signature header is rejected',
  (await post(pushBody, { 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=zz' })).status,
  401
);

const pingBody = JSON.stringify({ zen: 'Keep it logically awesome.' });
check(
  'valid signature is accepted',
  (await post(pingBody, { 'x-github-event': 'ping', 'x-hub-signature-256': sign(strongSecret, pingBody) })).status,
  200
);

const oversized = JSON.stringify({ ref: 'refs/heads/main', pad: 'x'.repeat(2 * 1024 * 1024) });
const oversizeResult = await post(oversized, {
  'x-github-event': 'push',
  'x-hub-signature-256': sign(strongSecret, oversized),
}).catch((error) => ({ status: `error:${error.code}` }));
check('oversized body is rejected', oversizeResult.status, 413);

child.kill();

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
