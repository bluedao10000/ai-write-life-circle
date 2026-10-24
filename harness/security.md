# 安全红线

本项目在 GitHub 上开源。本文说明如何安全处理敏感信息。

## 绝不提交到 Git 的信息

- `.env` 文件（含数据库密码、API 密钥）
- `.env.local` 或任何 `.env.*` 本地文件
- 私有密钥（`*.pem`、`*.key`）
- API 密钥和令牌
- 数据库凭证
- AWS 访问密钥
- 任何其他凭证或密钥

## 安全存储位置

| 信息 | 存储位置 |
| --- | --- |
| 数据库密码、API 密钥 | `.env`（本地，已加入 .gitignore） |
| AWS 凭证 | `~/.aws/config` |
| 私有密钥 | `~/.ssh/` |
| 生产 Bearer 令牌 | `/etc/writer-agent/auth-token`，权限 0640 |

## 部署前检查

提交前验证没有敏感信息：

```sh
git log -p | grep -i "password\|secret\|key\|token" | head
git diff --cached | grep -i "password\|secret"
git ls-files | grep ".env"   # 应只显示 .env.example
git status --short
```

## 生成强密码

```sh
openssl rand -base64 32
```

## 令牌权限

本地 curl 配置文件权限设为 0600。不要把令牌放进浏览器包或 Git。

## 凭证泄漏后的处理

1. 停止所有部署。
2. 撤销已推送的提交。
3. 清理 Git 历史。
4. 轮换所有凭证。
5. 通知相关人员。

## 最小检查清单

- [ ] `.env` 在 .gitignore 中
- [ ] 无 `.env` 文件被提交
- [ ] 所有凭证是占位符或自动生成
- [ ] SSH 密钥权限为 600
- [ ] `.env.example` 不含真实密钥

生产环境的系统加固见 [deploy-guide.md](deploy-guide.md)。
