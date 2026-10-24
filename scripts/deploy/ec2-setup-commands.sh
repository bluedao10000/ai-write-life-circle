#!/bin/bash

# EC2 自动化安装命令集合
# 通过 AWS SSM 执行

set -e

echo "=========================================="
echo "Step 1: 更新项目代码"
echo "=========================================="

cd /home/ubuntu/greenfield-adventures || {
  echo "项目目录不存在，需要先克隆"
  cd /home/ubuntu
  git clone https://github.com/story2u/ai-write-life-circle.git greenfield-adventures
  cd greenfield-adventures
}

# 拉取最新代码
git fetch origin
git reset --hard origin/main
git pull origin main

echo ""
echo "=========================================="
echo "Step 2: 安装 Webhook 服务"
echo "=========================================="

chmod +x scripts/deploy/setup-webhook.sh
./scripts/deploy/setup-webhook.sh

echo ""
echo "=========================================="
echo "Step 3: 检查服务状态"
echo "=========================================="

sleep 3
sudo systemctl status webhook --no-pager || true

echo ""
echo "=========================================="
echo "✅ 安装完成！"
echo "=========================================="
echo ""
echo "查看 webhook 配置信息："
sudo systemctl cat webhook 2>/dev/null | grep -i "WEBHOOK" || true

echo ""
echo "查看服务日志："
sudo journalctl -u webhook -n 20 --no-pager

echo ""
echo "测试健康检查："
curl -s http://localhost:9000/health | jq . || curl -s http://localhost:9000/health
