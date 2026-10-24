#!/usr/bin/env node

/**
 * GitHub Webhook 服务器
 * 监听 GitHub push 事件，自动拉取最新镜像并重启服务
 */

const http = require('http');
const crypto = require('crypto');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 配置
const PORT = process.env.WEBHOOK_PORT || 9000;
const SECRET = process.env.WEBHOOK_SECRET || '';
const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const LOG_FILE = path.join(PROJECT_DIR, 'webhook.log');
// GitHub 的 push 载荷通常远小于此值；上限用于阻断无界读取导致的内存耗尽。
const MAX_BODY_BYTES = Number(process.env.WEBHOOK_MAX_BODY_BYTES || 1048576);
// webhook.service 里的占位值不得被当作真实密钥使用。
const PLACEHOLDER_SECRETS = new Set(['your_secret_here_change_me', 'changeme', 'secret']);
const SECRET_IS_USABLE = SECRET.length >= 32 && !PLACEHOLDER_SECRETS.has(SECRET);

// 日志函数
function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  console.log(logMessage.trim());
  fs.appendFileSync(LOG_FILE, logMessage);
}

// 验证 GitHub 签名
// 失败即拒绝：未配置密钥、占位密钥、格式错误或长度不符都不允许放行。
function verifySignature(payload, signature) {
  if (!SECRET_IS_USABLE) {
    return false;
  }
  if (typeof signature !== 'string') {
    return false;
  }
  const match = /^sha256=([a-f0-9]{64})$/i.exec(signature.trim());
  if (!match) {
    return false;
  }
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest();
  const provided = Buffer.from(match[1], 'hex');
  if (provided.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(provided, expected);
}

// 执行部署
function deploy() {
  log('🚀 Starting deployment...');
  
  try {
    // 1. 拉取最新镜像
    log('📦 Pulling latest Docker image...');
    execSync('docker-compose pull web', {
      cwd: PROJECT_DIR,
      stdio: 'inherit'
    });
    
    // 2. 重启服务
    log('♻️  Restarting services...');
    execSync('docker-compose up -d', {
      cwd: PROJECT_DIR,
      stdio: 'inherit'
    });
    
    // 3. 清理旧镜像
    log('🧹 Cleaning up old images...');
    execSync('docker image prune -f', {
      stdio: 'inherit'
    });
    
    log('✅ Deployment completed successfully');
    return true;
  } catch (error) {
    log(`❌ Deployment failed: ${error.message}`);
    return false;
  }
}

// 创建 HTTP 服务器
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/webhook') {
    if (!SECRET_IS_USABLE) {
      log('❌ Refusing webhook: WEBHOOK_SECRET is missing, too short, or a placeholder value');
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        status: 'error',
        message: 'webhook secret not configured; refusing to deploy'
      }));
      return;
    }

    const chunks = [];
    let size = 0;
    let aborted = false;

    req.on('data', chunk => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        log(`❌ Rejecting webhook: body exceeds ${MAX_BODY_BYTES} bytes`);
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: 'payload too large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      // 按原始字节验签：GitHub 对字节流签名，转成字符串会破坏多字节字符。
      const body = Buffer.concat(chunks);
      try {
        // 验证签名
        const signature = req.headers['x-hub-signature-256'];
        if (!verifySignature(body, signature)) {
          log('❌ Invalid signature');
          res.writeHead(401);
          res.end('Invalid signature');
          return;
        }

        // 解析 payload
        const payload = JSON.parse(body.toString('utf8'));
        const event = req.headers['x-github-event'];

        log(`📨 Received GitHub event: ${event}`);

        // 只处理 push 事件
        if (event === 'push') {
          const ref = typeof payload.ref === 'string' ? payload.ref : '';
          const branch = ref.split('/').pop();
          
          log(`📍 Push to branch: ${branch}`);
          
          // 只部署 main 分支
          if (branch === 'main') {
            const commits = payload.commits || [];
            log(`📝 ${commits.length} commit(s) received`);
            
            commits.forEach(commit => {
              log(`  - ${commit.message.split('\n')[0]} (${commit.id.substring(0, 7)})`);
            });
            
            // 执行部署
            const success = deploy();
            
            res.writeHead(success ? 200 : 500);
            res.end(JSON.stringify({ 
              status: success ? 'success' : 'failed',
              message: success ? 'Deployment completed' : 'Deployment failed'
            }));
          } else {
            log(`⏭️  Skipping deployment for branch: ${branch}`);
            res.writeHead(200);
            res.end(JSON.stringify({ 
              status: 'skipped',
              message: `Branch ${branch} is not configured for auto-deployment`
            }));
          }
        } else if (event === 'ping') {
          log('🏓 Ping received');
          res.writeHead(200);
          res.end(JSON.stringify({ 
            status: 'ok',
            message: 'Webhook server is running'
          }));
        } else {
          log(`⏭️  Ignoring event: ${event}`);
          res.writeHead(200);
          res.end(JSON.stringify({ 
            status: 'ignored',
            message: `Event ${event} is not handled`
          }));
        }
      } catch (error) {
        log(`❌ Error processing webhook: ${error.message}`);
        res.writeHead(500);
        res.end(JSON.stringify({ 
          status: 'error',
          message: error.message
        }));
      }
    });
  } else if (req.method === 'GET' && req.url === '/health') {
    // 健康检查端点
    res.writeHead(200);
    res.end(JSON.stringify({ 
      status: 'healthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// 启动服务器
server.listen(PORT, '0.0.0.0', () => {
  log(`🚀 Webhook server listening on port ${PORT}`);
  log(`📁 Project directory: ${PROJECT_DIR}`);
  log(`🔐 Secret ${SECRET_IS_USABLE ? 'configured' : 'NOT usable — webhook requests will be refused (503)'}`);
  log(`📝 Logging to: ${LOG_FILE}`);
});

// 优雅关闭
process.on('SIGTERM', () => {
  log('📴 Received SIGTERM, shutting down gracefully...');
  server.close(() => {
    log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  log('📴 Received SIGINT, shutting down gracefully...');
  server.close(() => {
    log('✅ Server closed');
    process.exit(0);
  });
});
