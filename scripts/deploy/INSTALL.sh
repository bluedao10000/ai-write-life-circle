#!/bin/bash

# 一键安装脚本 - 在 EC2 上直接运行
# 使用方法：
# 1. 通过 AWS Console EC2 Instance Connect 连接到 EC2
# 2. 运行: bash <(curl -fsSL https://raw.githubusercontent.com/story2u/ai-write-life-circle/main/scripts/deploy/INSTALL.sh)

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_step() {
    echo -e "${GREEN}[✓]${NC} $1"
}

print_info() {
    echo -e "${BLUE}[i]${NC} $1"
}

print_error() {
    echo -e "${RED}[✗]${NC} $1"
}

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║         Greenfield Adventures - 自动部署安装               ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

PROJECT_DIR="$HOME/greenfield-adventures"

# 1. 克隆或更新代码
if [ -d "$PROJECT_DIR" ]; then
    print_info "项目目录已存在，更新代码..."
    cd "$PROJECT_DIR"
    git fetch origin
    git reset --hard origin/main
    git pull origin main
else
    print_info "克隆项目代码..."
    cd "$HOME"
    git clone https://github.com/story2u/ai-write-life-circle.git greenfield-adventures
    cd greenfield-adventures
fi

print_step "代码已更新到最新版本"

# 2. 运行 webhook 安装脚本
print_info "安装 Webhook 自动部署服务..."
echo ""
chmod +x scripts/deploy/setup-webhook.sh
./scripts/deploy/setup-webhook.sh

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║                    安装完成！                              ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
