#!/bin/bash

set -e  # 遇到错误立即退出

echo "=========================================="
echo "Greenfield Adventures - EC2 部署脚本"
echo "=========================================="

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_step() {
    echo -e "${GREEN}[步骤]${NC} $1"
}

print_error() {
    echo -e "${RED}[错误]${NC} $1"
}

print_info() {
    echo -e "${YELLOW}[信息]${NC} $1"
}

# 步骤 1: 检查 Docker 安装
print_step "检查 Docker 安装"
if ! command -v docker &> /dev/null; then
    print_error "Docker 未安装"
    print_step "安装 Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    sudo usermod -aG docker $USER
    rm get-docker.sh
    print_info "Docker 已安装，请重新登录或运行 'newgrp docker' 以应用新的用户组"
fi

print_info "Docker 版本: $(docker --version)"

# 步骤 2: 检查 Docker Compose 安装
print_step "检查 Docker Compose 安装"
if ! command -v docker-compose &> /dev/null; then
    print_error "Docker Compose 未安装"
    print_step "安装 Docker Compose..."
    sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    sudo chmod +x /usr/local/bin/docker-compose
    print_info "Docker Compose 已安装"
fi

print_info "Docker Compose 版本: $(docker-compose --version)"

# 步骤 3: 创建项目目录
print_step "创建项目目录"
PROJECT_DIR="/home/ubuntu/greenfield-adventures"
if [ ! -d "$PROJECT_DIR" ]; then
    mkdir -p "$PROJECT_DIR"
    print_info "创建目录: $PROJECT_DIR"
else
    print_info "目录已存在: $PROJECT_DIR"
fi

# 步骤 4: 上传或克隆项目文件
print_step "检查项目文件"
if [ ! -f "$PROJECT_DIR/docker-compose.yml" ]; then
    print_info "项目文件不存在，等待上传..."
    print_info "请从本地上传项目文件到 $PROJECT_DIR"
    read -p "文件已上传? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_error "取消部署"
        exit 1
    fi
else
    print_info "项目文件已存在"
fi

cd "$PROJECT_DIR"

# 步骤 5: 创建 .env 文件
print_step "配置环境变量"
if [ ! -f "$PROJECT_DIR/.env" ]; then
    print_info "创建 .env 文件"
    
    # 生成安全的数据库密码
    DB_PASSWORD=$(openssl rand -base64 32)
    
    cat > .env << EOF
# PostgreSQL 配置
DB_NAME=greenfield_adventures
DB_USER=postgres
DB_PASSWORD=$DB_PASSWORD
DB_PORT=5432

# Web 应用配置
WEB_PORT=3000

# Writer Agent 模式
WRITER_AGENT_MODE=demo

# 环境
NODE_ENV=production
EOF
    
    # 设置严格的文件权限
    chmod 600 .env
    
    print_info ".env 文件已创建 (权限: 600)"
    print_info "⚠️  PostgreSQL 密码已生成并保存在 .env（仅本机可读）"
    print_info "⚠️  请保存此密码到安全位置（密码管理器）"
    
    # 显示密码一次（仅在屏幕上，不记录）
    echo ""
    echo "========================================"
    echo "临时数据库密码（请立即保存）："
    echo "========================================"
    echo "$DB_PASSWORD"
    echo "========================================"
    echo ""
    read -p "已确认并保存密码? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_error "请保存密码后重新运行脚本"
        exit 1
    fi
else
    print_info ".env 文件已存在"
fi

# 步骤 6: 构建并启动容器
print_step "构建 Docker 镜像"
docker-compose build --no-cache

print_step "启动容器"
docker-compose up -d

# 步骤 7: 等待服务启动
print_step "等待服务启动"
sleep 10

# 步骤 8: 检查服务状态
print_step "检查服务状态"
docker-compose ps

# 步骤 9: 测试 Web 应用
print_step "测试 Web 应用"
WEB_URL="http://localhost:3000"
if curl -f --silent --connect-timeout 5 "$WEB_URL" > /dev/null; then
    print_info "✓ Web 应用已启动: $WEB_URL"
else
    print_error "✗ Web 应用无法访问"
fi

# 步骤 10: 测试 PostgreSQL
print_step "测试 PostgreSQL"
if docker-compose exec -T postgres pg_isready -U postgres > /dev/null 2>&1; then
    print_info "✓ PostgreSQL 已启动"
else
    print_error "✗ PostgreSQL 无法连接"
fi

# 步骤 11: 显示摘要
print_step "部署完成！"
echo ""
echo "=========================================="
echo "服务摘要"
echo "=========================================="
echo "Web 应用:    http://localhost:3000"
echo "PostgreSQL: localhost:5432"
echo "数据库:     greenfield_adventures"
echo "数据库用户: postgres"
echo ""
echo "有用命令:"
echo "  查看日志:       docker-compose logs -f"
echo "  停止服务:       docker-compose stop"
echo "  启动服务:       docker-compose start"
echo "  重启服务:       docker-compose restart"
echo "  查看状态:       docker-compose ps"
echo "  进入 PostgreSQL: docker-compose exec postgres psql -U postgres"
echo "=========================================="
echo ""

print_info "部署脚本执行完成！"
