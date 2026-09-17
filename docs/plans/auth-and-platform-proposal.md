# 博客动态站认证与平台方案建议

> **文档状态：前期设计建议，尚未实现。**
>
> 实施前必须依据实际代码、供应商套餐和安全要求重新验证。

## 1. 目标与站点边界

| 站点 | 拟议位置/构建 | 职责 |
| Vercel 动态站 | `vercel-app/`，`npm run build` | 作品集首页、账号、资料、文章收藏与邮箱认证 |

动态站可沿用 GitHub Pages 的内容和视觉语言。认证不应打断首页浏览：账户菜单提供登录、注册、个人中心和账号设置；访客只在文章详情页尝试收藏时才被引导登录，并保留回跳地址。

## 2. 拟议认证与资料体验

- 使用 QQ 邮箱与密码注册：输入邮箱 → 获取六位验证码 → 输入验证码、密码、昵称 → 自动登录。
- 登录、注册、验证码和密码重置可由 Next.js API 自行管理，不依赖 Neon Auth；对不存在邮箱的重置请求返回统一成功提示，避免账号枚举。
- 成功认证后，服务端签发 JWT 会话 Cookie。生产环境建议使用 `__Host-session`，并设置 `HttpOnly`、`Secure`、`SameSite=Lax`、`Path=/` 与 30 天有效期；本地 HTTP 开发可改用普通 `session` Cookie。
- `users.id` 作为永久、不可见且不可修改的内部 UUID；`profiles.handle` 作为唯一公开账号。注册时可由服务端自动生成 `u_<20位UUID片段>`，无需要求用户填写。
- 公开账号可在设置页修改。建议首次不受限，之后按 `Asia/Shanghai` 自然月最多修改一次；昵称和姓氏可随时修改。
- 账户菜单：访客显示登录/注册；登录用户显示昵称，并可查看完整昵称、QQ 邮箱、个人中心、账号设置和退出入口。
- 文章详情页可提供收藏，但访客不能收藏，也不创建匿名账号或匿名业务数据。可规划 `/account` 展示资料与收藏，`/account/settings` 管理资料和公开账号。

## 3. 模块边界与 API

建议以以下边界实现，减少未来替换成本：

| 模块 | 拟议位置 | 可替换方向 |
| --- | --- | --- |
| 会话 | `vercel-app/lib/auth/session.ts` | JWT Cookie、Redis Session、OAuth 或托管身份服务 |
| 密码 | `vercel-app/lib/auth/password.ts` | Node `scrypt` 或其他密码算法/认证服务 |
| 邮件 | `vercel-app/lib/auth/email.ts` | QQ SMTP/Nodemailer、Resend、腾讯云邮件推送等 |
| 验证码与限流 | `vercel-app/lib/database/auth-repository.ts` | 可替换数据库实现，业务层不直接依赖邮件客户端 |
| 用户、资料与收藏 | `vercel-app/lib/database/*.ts` | Neon PostgreSQL；改用非 PostgreSQL 时重写 repository |

拟议 API：

- `POST /api/auth/send-code`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/reset-password`
- `POST /api/auth/logout`
- `GET /api/auth/me`


## 4. 环境变量与密钥管理

真实值只应保存在 Vercel 或未追踪的 `.env.local`，不得写入本文、代码仓库或工单。

| 变量 | 类型 | 用途 |
| --- | --- | --- |
| `DATABASE_URL` | Secret | Neon PostgreSQL 池化连接串 |
| `AUTH_JWT_SECRET` | Secret | JWT 会话签名密钥，建议至少 32 个随机字符 |
| `AUTH_CODE_SECRET` | Secret | 验证码与邮箱摘要 HMAC 密钥，必须不同于 JWT 密钥 |
| `CRON_SECRET` | Secret | 每日清理任务鉴权密钥，必须独立 |
| `QQ_EMAIL_USER` | Secret | 完整 QQ 邮箱地址 |
| `QQ_EMAIL_PASS` | Secret | QQ SMTP 授权码，而非 QQ 登录密码 |
| `SMTP_HOST` / `SMTP_PORT` | Config | 建议为 `smtp.qq.com` / `465` |
| `EMAIL_FROM` | Config | 例如 `"melondy101 <your-qq-number@qq.com>"` |
| `NEXT_PUBLIC_SITE_URL` | Config | 公开生产站点 URL |

## 5. 邮件、限流与容量假设

### QQ SMTP

- 建议使用 `smtp.qq.com:465` 并启用 SSL。
- QQ 个人 SMTP 不适合作为对外承诺的固定日发信额度，实际可用容量会受账号信誉、陌生收件人、退信、投诉和发送速率影响。
- 它适合作为早期个人项目方案；日注册持续超过约 100 人，或出现退信、风控时，应优先迁移到专业事务邮件服务。

### 验证码限制建议

所有时间按 `Asia/Shanghai` 自然日计算：

| 范围 | 建议上限 |
| --- | ---: |
| 全站验证码 | 100 封/天；15 封/小时 |
| 单 IP | 20 封/天 |
| 单邮箱 | 5 封/天 |
| 单 IP 或单邮箱 | 最短间隔 60 秒；15 分钟最多 3 封 |
| 单验证码 | 10 分钟有效，最多 5 次错误 |
| 登录或重置校验 | 单 IP/邮箱 15 分钟最多 10 次 |

限制命中时建议 API 返回 `429`。在此预算下，早期新增注册可保守规划为约 60--80 人/天，为重发和密码重置保留余量。

### 免费层容量估算

以下仅为设计阶段的保守运营估计，并非供应商 SLA；实施或上线前需重新核对最新套餐。

- 总注册量可先按 1 万--5 万规划；认证日志与存储增长可能早于 UUID 数量成为约束。
- 数百级日活、约 10--30 人同时登录、收藏或保存设置，是稳妥的早期目标；静态浏览通常不是主要瓶颈。
- 需根据上线时的 Vercel 和 Neon 套餐复核函数调用、计算时间、内存、数据库 CU-hours 与存储限制。
- 连续活跃数据库通常比注册总量更早触发升级需求。

## 7. 自动清理任务建议

- 可设置 `GET /api/cron/auth-cleanup`，并在 `vercel-app/vercel.json` 配置 Cron。
- 建议计划为 `10 16 * * *`（UTC），即北京时间每天 00:10。
- Vercel 应携带 `Authorization: Bearer $CRON_SECRET` 调用；未授权请求返回 `401`。
- 建议清理过期 `email_verifications` 和超过 24 小时的 `auth_attempts`。
- 即使 Cron 失败，验证码校验本身仍必须检查过期时间。

## 8. Vercel 部署与排障建议

拟议的 Next.js 动态站可使用以下设置：

- Root Directory：`vercel-app`
- Framework Preset：`Next.js`
- Output Directory：留空或关闭 Override；不要填 `public`、`dist` 或 `.next`
- Build Command：留空或 `npm run build`
- Install Command：`npm install`

`vercel-app/vercel.json` 可显式声明 `framework: "nextjs"` 并配置 Cron。若控制台显示“Production deployment differs from Project Settings”，应检查并清除旧的 Framework/Output Directory Production Override。

`No Output Directory named "public" found after the Build completed` 常表示项目被当作 Other/静态站处理，或 Production Override 强制使用 `public`；它不必然表示 Next.js 代码构建失败。

## 9. 实施后验收条件

以下是建议实现后的验收项，而不是当前已达成状态：

1. 具备生产数据保护方案。
2. 安全配置所需环境变量，特别是独立的 `CRON_SECRET`。
3. Vercel Root Directory、Framework 和 Output Directory 符合第 8 节
4. 用户可收取验证码，注册后自动登录，注册表单不强制填写公开账号。
5. 账号设置展示自动公开账号；首次修改成功，同月后续修改被限制。
6. 访客可浏览首页；收藏会引导登录；访客不产生业务数据。
7. 验证 60 秒重复发送、15 分钟第四次、单邮箱第六次和全站额度耗尽均返回 `429`。
8. Vercel Cron 日志显示认证清理调用，且没有 `401`。
9. 在 `vercel-app` 运行 `npm test`、`npm run build`，并在仓库根目录运行 `npm run build`。

## 10. 后续演进建议

1. 上线后观察至少 14 天 QQ SMTP 送达率、拒发与限流命中率；无异常后再评估提高总发信额度。
2. 注册量稳定超过 100/天或出现 QQ 发信风控时，优先替换为专业事务邮件服务。
3. 日活稳定达到千级，或数据库 CU-hours 经常接近套餐额度时，评估升级 Neon 或迁移数据库。
4. 增加不对外暴露的可观测性：邮件发送成功率、Cron 清理行数、限流命中率和数据库大小。
