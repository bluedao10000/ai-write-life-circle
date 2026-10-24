#!/bin/bash

# 为 GitHub Actions 创建 IAM 用户和访问密钥
# 适用于无法使用 OIDC 的受限 AWS 账户

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

# 配置变量
AWS_REGION="eu-north-1"
AWS_PROFILE="greenfield-adventures"
IAM_USER_NAME="github-actions-ecr"
POLICY_NAME="GitHubActionsECRPolicy"

echo "=========================================="
echo "GitHub Actions IAM 用户配置"
echo "=========================================="
echo ""
print_warning "注意: 此方法使用长期访问密钥，不如 OIDC 安全"
print_warning "仅在无法使用 OIDC 时使用此方法"
echo ""

print_info "配置信息："
echo "  IAM User: $IAM_USER_NAME"
echo "  AWS Region: $AWS_REGION"
echo "  AWS Profile: $AWS_PROFILE"
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

# 步骤 1: 创建 IAM 用户
print_step "创建 IAM 用户"
if aws iam get-user --user-name "$IAM_USER_NAME" --profile $AWS_PROFILE &>/dev/null; then
    print_warning "用户已存在: $IAM_USER_NAME"
else
    print_info "创建新用户..."
    aws iam create-user \
        --user-name "$IAM_USER_NAME" \
        --profile $AWS_PROFILE
    print_info "✓ 用户创建成功"
fi

# 步骤 2: 创建 ECR 权限策略
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

# 步骤 3: 附加策略到用户
print_step "附加策略到用户"
aws iam attach-user-policy \
    --user-name "$IAM_USER_NAME" \
    --policy-arn "$POLICY_ARN" \
    --profile $AWS_PROFILE 2>/dev/null || print_info "策略已附加"
print_info "✓ 权限配置完成"

# 步骤 4: 创建访问密钥
print_step "创建访问密钥"
print_warning "正在创建访问密钥..."
print_warning "请妥善保存，密钥只显示一次！"
echo ""

ACCESS_KEY_OUTPUT=$(aws iam create-access-key \
    --user-name "$IAM_USER_NAME" \
    --profile $AWS_PROFILE \
    --output json)

ACCESS_KEY_ID=$(echo "$ACCESS_KEY_OUTPUT" | grep -o '"AccessKeyId": "[^"]*"' | cut -d'"' -f4)
SECRET_ACCESS_KEY=$(echo "$ACCESS_KEY_OUTPUT" | grep -o '"SecretAccessKey": "[^"]*"' | cut -d'"' -f4)

# 清理临时文件
rm -f /tmp/ecr-policy.json

echo ""
echo "=========================================="
echo "✅ 配置完成！"
echo "=========================================="
echo ""
echo "🔑 访问密钥（请立即保存，之后无法再次查看）："
echo ""
echo "  Access Key ID:     $ACCESS_KEY_ID"
echo "  Secret Access Key: $SECRET_ACCESS_KEY"
echo ""
echo "=========================================="
echo ""
echo "📋 下一步操作："
echo ""
echo "1️⃣  在 GitHub 仓库中设置 Secrets："
echo ""
echo "   访问: https://github.com/story2u/ai-write-life-circle/settings/secrets/actions"
echo ""
echo "   添加两个 Secrets:"
echo ""
echo "   Secret 1:"
echo "   Name:  AWS_ACCESS_KEY_ID"
echo "   Value: $ACCESS_KEY_ID"
echo ""
echo "   Secret 2:"
echo "   Name:  AWS_SECRET_ACCESS_KEY"
echo "   Value: $SECRET_ACCESS_KEY"
echo ""
echo "2️⃣  更新 GitHub Actions 工作流："
echo ""
echo "   需要修改 .github/workflows/build-and-push-ecr.yml"
echo "   将 OIDC 认证改为 Access Key 认证"
echo ""
echo "3️⃣  推送代码测试："
echo ""
echo "   git push origin main"
echo ""
echo "=========================================="
echo ""
echo "⚠️  安全提示："
echo ""
echo "  - 这些密钥具有 ECR 推送权限"
echo "  - 不要将密钥提交到代码仓库"
echo "  - 定期轮换访问密钥（建议每 90 天）"
echo "  - 如果密钥泄露，立即删除并重新创建"
echo ""
echo "  删除密钥命令："
echo "  aws iam delete-access-key \\"
echo "    --user-name $IAM_USER_NAME \\"
echo "    --access-key-id $ACCESS_KEY_ID \\"
echo "    --profile $AWS_PROFILE"
echo ""

