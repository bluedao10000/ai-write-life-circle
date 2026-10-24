#!/bin/bash

# 本脚本用于从本地上传项目到 EC2 实例
# 用法: ./upload-to-ec2.sh <EC2_IP>

set -e

if [ -z "$1" ]; then
    echo "错误: 请提供 EC2 实例的公网 IP 地址"
    echo "用法: ./upload-to-ec2.sh <EC2_PUBLIC_IP>"
    echo ""
    echo "示例: ./upload-to-ec2.sh 16.170.155.138"
    exit 1
fi

EC2_IP=$1
EC2_USER=${2:-ubuntu}
EC2_KEY=${3:-/Users/bruce/git/story/keys/aws.pem}
REMOTE_DIR="/home/$EC2_USER/greenfield-adventures"

echo "=========================================="
echo "上传项目到 EC2"
echo "=========================================="
echo "目标 IP:        $EC2_IP"
echo "用户:          $EC2_USER"
echo "远程目录:       $REMOTE_DIR"
echo ""

# 检查 SSH 密钥
if [ ! -f "$EC2_KEY" ]; then
    echo "错误: SSH 密钥不存在: $EC2_KEY"
    echo "请指定正确的密钥文件路径作为第三个参数"
    exit 1
fi

# 检查远程主机连接
echo "检查连接..."
if ! ssh -i "$EC2_KEY" -o ConnectTimeout=5 "$EC2_USER@$EC2_IP" "echo '连接成功'" 2>/dev/null; then
    echo "错误: 无法连接到 EC2 实例"
    echo "请检查:"
    echo "  1. IP 地址是否正确"
    echo "  2. SSH 密钥是否正确"
    echo "  3. 安全组是否允许 SSH 访问"
    exit 1
fi

# 清理不需要的文件
echo ""
echo "准备文件..."

# 创建临时目录
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# 复制文件到临时目录
cp -r . "$TEMP_DIR/project" 2>/dev/null || true

# 移除不需要的文件和目录
cd "$TEMP_DIR/project"
rm -rf \
    .git \
    .claude \
    .comet \
    .workbuddy \
    .github \
    node_modules \
    apps/*/node_modules \
    packages/*/node_modules \
    apps/*/dist \
    .env \
    .env.local \
    *.log \
    2>/dev/null || true

cd "$TEMP_DIR"

# 计算文件大小
SIZE=$(du -sh project | cut -f1)
echo "需要上传的文件大小: $SIZE"
echo ""

# 创建远程目录
echo "在远程服务器上创建目录..."
ssh -i "$EC2_KEY" "$EC2_USER@$EC2_IP" "mkdir -p $REMOTE_DIR"

# 上传文件
echo "上传文件..."
scp -i "$EC2_KEY" -r "project/" "$EC2_USER@$EC2_IP:$REMOTE_DIR/"

# 设置正确的权限
echo "设置权限..."
ssh -i "$EC2_KEY" "$EC2_USER@$EC2_IP" "chmod +x $REMOTE_DIR/deploy-ec2.sh"

echo ""
echo "=========================================="
echo "✓ 上传完成！"
echo "=========================================="
echo ""
echo "后续步骤:"
echo "1. 通过 EC2 Instance Connect 或 SSH 连接到实例"
echo "2. 执行: cd $REMOTE_DIR && ./deploy-ec2.sh"
echo ""
echo "SSH 命令（如需要）:"
echo "  ssh -i $EC2_KEY $EC2_USER@$EC2_IP"
echo ""
