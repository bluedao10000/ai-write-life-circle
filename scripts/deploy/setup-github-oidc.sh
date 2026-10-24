#!/bin/bash

# 设置 GitHub OIDC 和 IAM 角色
# 用于 GitHub Actions 访问 AWS ECR

set -e

# 颜色定义
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

# 配置变量
AWS_REGION="eu-north-1"
AWS_PROFILE="greenfield-adventures"
GITHUB_ORG_OR_USER=""  # 需要用户输入
GITHUB_REPO="ai-write-life-circle"
ROLE_NAME="GitHubActionsECRRole"

echo "=========================================="
echo "GitHub OIDC + AWS IAM 配置向导"
echo "=========================================="
echo ""

# 获取 GitHub 用户名/组织名
read -p "请输入你的 GitHub 用户名或组织名: " GITHUB_ORG_OR_USER
if [ -z "$GITHUB_ORG_OR_USER" ]; then
    print_error "GitHub 用户名不能为空"
    exit 1
fi

echo ""
print_info "配置信息："
echo "  GitHub: $GITHUB_ORG_OR_USER/$GITHUB_REPO"
echo "  AWS Region: $AWS_REGION"
echo "  AWS Profile: $AWS_PROFILE"
echo "  IAM Role: $ROLE_NAME"
echo ""
read -p "确认继续？(y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    print_error "取消操作"
    exit 1
fi

# 获取 AWS 账户 ID
print_step "获取 AWS 账户 ID"
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --profile $AWS_PROFILE)
print_info "AWS Account ID: $AWS_ACCOUNT_ID"

# 步骤 1: 创建 OIDC 提供商
print_step "检查 GitHub OIDC 提供商"
OIDC_PROVIDER_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"

if aws iam get-open-id-connect-provider \
    --open-id-connect-provider-arn "$OIDC_PROVIDER_ARN" \
    --profile $AWS_PROFILE &>/dev/null; then
    print_info "✓ OIDC 提供商已存在"
else
    print_info "创建 GitHub OIDC 提供商..."
    aws iam create-open-id-connect-provider \
        --url "https://token.actions.githubusercontent.com" \
        --client-id-list "sts.amazonaws.com" \
        --thumbprint-list "6938fd4d98bab03faadb97b34396831e3780aea1" \
        --profile $AWS_PROFILE
    print_info "✓ OIDC 提供商创建成功"
fi

# 步骤 2: 创建信任策略文档
print_step "创建 IAM 角色信任策略"
TRUST_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::${AWS_ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:${GITHUB_ORG_OR_USER}/${GITHUB_REPO}:*"
        }
      }
    }
  ]
}
EOF
)

echo "$TRUST_POLICY" > /tmp/trust-policy.json
print_info "信任策略已保存到 /tmp/trust-policy.json"

# 步骤 3: 创建或更新 IAM 角色
print_step "创建 IAM 角色"
if aws iam get-role --role-name "$ROLE_NAME" --profile $AWS_PROFILE &>/dev/null; then
    print_warning "角色已存在，更新信任策略..."
    aws iam update-assume-role-policy \
        --role-name "$ROLE_NAME" \
        --policy-document file:///tmp/trust-policy.json \
        --profile $AWS_PROFILE
    print_info "✓ 信任策略已更新"
else
    print_info "创建新角色..."
    aws iam create-role \
        --role-name "$ROLE_NAME" \
        --assume-role-policy-document file:///tmp/trust-policy.json \
        --description "Role for GitHub Actions to push to ECR" \
        --profile $AWS_PROFILE
    print_info "✓ IAM 角色创建成功"
fi

# 步骤 4: 创建 ECR 权限策略
print_step "创建 ECR 访问权限策略"
ECR_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:GetRepositoryPolicy",
        "ecr:DescribeRepositories",
        "ecr:ListImages",
        "ecr:DescribeImages",
        "ecr:BatchGetImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage"
      ],
      "Resource": "arn:aws:ecr:${AWS_REGION}:${AWS_ACCOUNT_ID}:repository/greenfield-web"
    }
  ]
}
EOF
)

echo "$ECR_POLICY" > /tmp/ecr-policy.json
print_info "ECR 策略已保存到 /tmp/ecr-policy.json"

# 步骤 5: 附加权限策略
print_step "附加 ECR 权限策略到角色"
POLICY_NAME="GitHubActionsECRPolicy"
POLICY_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:policy/${POLICY_NAME}"

# 检查策略是否存在
if aws iam get-policy --policy-arn "$POLICY_ARN" --profile $AWS_PROFILE &>/dev/null; then
    print_warning "策略已存在，创建新版本..."
    aws iam create-policy-version \
        --policy-arn "$POLICY_ARN" \
        --policy-document file:///tmp/ecr-policy.json \
        --set-as-default \
        --profile $AWS_PROFILE &>/dev/null || print_info "策略版本已是最新"
else
    print_info "创建新策略..."
    aws iam create-policy \
        --policy-name "$POLICY_NAME" \
        --policy-document file:///tmp/ecr-policy.json \
        --description "ECR access for GitHub Actions" \
        --profile $AWS_PROFILE
fi

# 附加策略到角色
print_info "附加策略到角色..."
aws iam attach-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-arn "$POLICY_ARN" \
    --profile $AWS_PROFILE 2>/dev/null || print_info "策略已附加"

print_info "✓ ECR 权限配置完成"

# 步骤 6: 验证配置
print_step "验证配置"
ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${ROLE_NAME}"
print_info "获取角色信息..."
aws iam get-role --role-name "$ROLE_NAME" --profile $AWS_PROFILE --output json | grep -A1 "Arn"

# 清理临时文件
rm -f /tmp/trust-policy.json /tmp/ecr-policy.json

echo ""
echo "=========================================="
echo "✅ 配置完成！"
echo "=========================================="
echo ""
echo "📋 下一步操作："
echo ""
echo "1️⃣  在 GitHub 仓库中设置 Secret："
echo ""
echo "   访问: https://github.com/${GITHUB_ORG_OR_USER}/${GITHUB_REPO}/settings/secrets/actions"
echo ""
echo "   添加 Secret:"
echo "   Name:  AWS_ROLE_TO_ASSUME"
echo "   Value: ${ROLE_ARN}"
echo ""
echo "2️⃣  推送代码测试 GitHub Actions："
echo ""
echo "   git push origin main"
echo ""
echo "3️⃣  查看 GitHub Actions 执行："
echo ""
echo "   https://github.com/${GITHUB_ORG_OR_USER}/${GITHUB_REPO}/actions"
echo ""
echo "=========================================="
echo ""
echo "🔑 重要信息（请保存）："
echo ""
echo "  AWS Account ID:  $AWS_ACCOUNT_ID"
echo "  AWS Region:      $AWS_REGION"
echo "  IAM Role ARN:    $ROLE_ARN"
echo "  OIDC Provider:   $OIDC_PROVIDER_ARN"
echo "  GitHub Repo:     ${GITHUB_ORG_OR_USER}/${GITHUB_REPO}"
echo ""

