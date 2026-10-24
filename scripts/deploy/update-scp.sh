#!/bin/bash

# 更新 SCP 策略以允许 IAM OIDC 操作
# 需要在 AWS Organizations 管理账户中运行

set -e

MANAGEMENT_PROFILE="default"  # 改为你的管理账户 profile
POLICY_ID="p-btpq8wte"
MEMBER_ACCOUNT="028610956878"

echo "=========================================="
echo "更新 SCP 策略 - 允许 IAM OIDC"
echo "=========================================="
echo ""

# 1. 获取当前策略
echo "[1/4] 获取当前 SCP 策略..."
CURRENT_POLICY=$(aws organizations describe-policy \
  --policy-id "$POLICY_ID" \
  --profile "$MANAGEMENT_PROFILE" \
  --query 'Policy.Content' \
  --output text)

echo "当前策略:"
echo "$CURRENT_POLICY" | jq .

# 2. 备份当前策略
echo ""
echo "[2/4] 备份当前策略..."
echo "$CURRENT_POLICY" > /tmp/scp-backup-$(date +%Y%m%d-%H%M%S).json
echo "已备份到: /tmp/scp-backup-$(date +%Y%m%d-%H%M%S).json"

# 3. 创建新策略（添加 IAM OIDC 例外）
echo ""
echo "[3/4] 创建新策略..."

# 这里需要根据实际的 SCP 内容来修改
# 通常是在 Deny 语句中添加 Condition 来排除特定资源

cat > /tmp/new-scp-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Deny",
      "Action": [
        "iam:CreateOpenIDConnectProvider",
        "iam:DeleteOpenIDConnectProvider",
        "iam:GetOpenIDConnectProvider",
        "iam:ListOpenIDConnectProviders",
        "iam:UpdateOpenIDConnectProviderThumbprint"
      ],
      "Resource": "*",
      "Condition": {
        "StringNotLike": {
          "iam:ResourceTag/AllowedOIDC": "GitHub"
        }
      }
    }
  ]
}
EOF

echo "新策略内容:"
cat /tmp/new-scp-policy.json | jq .

# 4. 更新策略
echo ""
echo "[4/4] 更新 SCP 策略..."
read -p "确认更新策略？这会影响组织中的所有账户。(yes/no) " -r
if [[ $REPLY != "yes" ]]; then
    echo "取消更新"
    exit 1
fi

aws organizations update-policy \
  --policy-id "$POLICY_ID" \
  --content file:///tmp/new-scp-policy.json \
  --profile "$MANAGEMENT_PROFILE"

echo ""
echo "✅ 策略更新成功！"
echo ""
echo "现在可以在成员账户中创建 OIDC 提供商了："
echo ""
echo "  aws iam create-open-id-connect-provider \\"
echo "    --url 'https://token.actions.githubusercontent.com' \\"
echo "    --client-id-list 'sts.amazonaws.com' \\"
echo "    --thumbprint-list '6938fd4d98bab03faadb97b34396831e3780aea1' \\"
echo "    --profile greenfield-adventures"
echo ""
