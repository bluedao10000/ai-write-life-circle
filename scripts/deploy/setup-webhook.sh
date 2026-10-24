#!/bin/bash

# 设置 GitHub Webhook 自动部署
# 在 EC2 上运行此脚本

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_step() {
    echo -e "${GREEN}[步骤]${NC} $1"
}

print_info() {
    echo -e "${BLUE}[信息]${NC} $1"
}

print_error() {
    echo -e "${RED}[错误]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[警告]${NC} $1"
}

PROJECT_DIR="$HOME/greenfield-adventures"

echo "=========================================="
echo "GitHub Webhook 自动部署配置"
echo "=========================================="
echo ""

# 步骤 1: 检查 Node.js
print_step "检查 Node.js"
if ! command -v node &> /dev/null; then
    print_info "安装 Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi
print_info "Node.js 版本: $(node --version)"

# 步骤 2: 生成 Webhook Secret
print_step "生成 Webhook Secret"
WEBHOOK_SECRET=$(openssl rand -hex 32)
print_info "Secret 已生成: $WEBHOOK_SECRET"
echo ""
print_warning "⚠️  请保存此 Secret，稍后需要在 GitHub 中配置"
echo ""

# 步骤 3: 配置 systemd 服务
print_step "配置 systemd 服务"

# 更新服务文件中的 secret
sed -i "s|your_secret_here_change_me|$WEBHOOK_SECRET|" "$PROJECT_DIR/scripts/deploy/webhook.service"

# 复制服务文件
sudo cp "$PROJECT_DIR/scripts/deploy/webhook.service" /etc/systemd/system/
sudo chmod 644 /etc/systemd/system/webhook.service

# 添加执行权限
chmod +x "$PROJECT_DIR/scripts/deploy/webhook-server.js"

print_info "✓ systemd 服务已配置"

# 步骤 4: 启动服务
print_step "启动 webhook 服务"
sudo systemctl daemon-reload
sudo systemctl enable webhook.service
sudo systemctl start webhook.service

sleep 2

# 检查状态
if sudo systemctl is-active --quiet webhook.service; then
    print_info "✓ Webhook 服务运行正常"
else
    print_error "✗ Webhook 服务启动失败"
    sudo systemctl status webhook.service
    exit 1
fi

# 步骤 5: 配置防火墙（如果需要）
print_step "配置防火墙"
if command -v ufw &> /dev/null; then
    if sudo ufw status | grep -q "Status: active"; then
        print_info "配置 UFW 防火墙规则..."
        sudo ufw allow 9000/tcp comment "GitHub Webhook"
        print_info "✓ 防火墙规则已添加"
    else
        print_info "UFW 未启用，跳过"
    fi
else
    print_info "UFW 未安装，跳过防火墙配置"
fi

# 步骤 6: 测试 webhook 服务器
print_step "测试 webhook 服务器"
sleep 1
if curl -s http://localhost:9000/health | grep -q "healthy"; then
    print_info "✓ Webhook 服务器响应正常"
else
    print_error "✗ Webhook 服务器无响应"
fi

# 步骤 7: 获取公网 IP
print_step "获取服务器信息"
PUBLIC_IP=$(curl -s http://checkip.amazonaws.com)
print_info "公网 IP: $PUBLIC_IP"

echo ""
echo "=========================================="
echo "✅ Webhook 配置完成！"
echo "=========================================="
echo ""
echo "📋 下一步在 GitHub 配置 Webhook："
echo ""
echo "1️⃣  访问仓库设置："
echo "   https://github.com/story2u/ai-write-life-circle/settings/hooks"
echo ""
echo "2️⃣  点击 'Add webhook' 并填写："
echo ""
echo "   Payload URL:"
echo "   http://${PUBLIC_IP}:9000/webhook"
echo ""
echo "   Content type:"
echo "   application/json"
echo ""
echo "   Secret:"
echo "   $WEBHOOK_SECRET"
echo ""
echo "   Which events:"
echo "   ☑ Just the push event"
echo ""
echo "   Active:"
echo "   ☑ Active"
echo ""
echo "3️⃣  点击 'Add webhook'"
echo ""
echo "=========================================="
echo ""
echo "🔧 管理命令："
echo ""
echo "  查看状态:   sudo systemctl status webhook"
echo "  查看日志:   sudo journalctl -u webhook -f"
echo "  重启服务:   sudo systemctl restart webhook"
echo "  停止服务:   sudo systemctl stop webhook"
echo "  查看 webhook 日志: tail -f $PROJECT_DIR/webhook.log"
echo ""
echo "🧪 测试部署："
echo ""
echo "  推送代码到 main 分支，webhook 会自动触发部署"
echo ""
echo "⚠️  安全建议："
echo ""
echo "  - 确保 EC2 安全组只允许必要的 IP 访问 9000 端口"
echo "  - 或者使用 Nginx 反向代理并配置 HTTPS"
echo "  - 定期轮换 webhook secret"
echo ""

