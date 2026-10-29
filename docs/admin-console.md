# 管理后台运维手册（/admin/）

代码已上线（提交 `2cad32f`）。首次使用前需要完成下面「一次性初始化」；
此后站点参数与广告开关都可以在网页后台里改，无需再改代码或重新部署。

---

## 一次性初始化

### 1. 设置初始化密钥

在**已登录 Cloudflare 的终端**里、仓库根目录执行：

```powershell
npx wrangler secret put ADMIN_SETUP_KEY --config wrangler.zh.jsonc
```

提示输入时粘贴一个自己定的强口令（建议 24 位以上随机串，可用密码管理器生成）。
这一步不会触发重新部署脚本内容——但如果部署过很久，想立刻生效可再执行一次：

```powershell
npm run deploy:zh
```

> 为什么必须手动设：这个密钥只该存在于 Cloudflare，不进 Git、也不进构建产物。
> 没配置时 `/api/admin/setup` 一律 503 关闭，任何陌生人都无法抢注管理员。

### 2. 创建管理员账户

浏览器打开 `https://skill.gautown.top/admin/`：

1. 展开「首次初始化（需要引导密钥）」
2. 引导密钥填上一步的值
3. 填账户（3-32 位字母/数字/`.`/`_`/`-`）和密码（8-128 位）
4. 点「创建管理员」→ 出现「管理员已创建」后收起面板，用刚建的账户登录

账户与密码**只以 PBKDF2-SHA256 哈希（含随机盐）存进 KV**，KV 里没有明文。

---

## 日常使用

登录 `https://skill.gautown.top/admin/` 后可改：

| 区块 | 字段 | 生效范围 |
|---|---|---|
| 站点参数 | 站点名称 | 全站五语言的页头品牌名、页脚标题 |
| 站点参数 | 站点描述 | 全站页脚描述 |
| 站点参数 | 页脚备注 | 页脚右侧（默认 “Built with Astro”） |
| 广告模块 | 启用广告 | 总开关；关闭后首页/详情页不再注入 Ezoic |
| 广告模块 | Side Rails | 仅左侧 / 左右两侧 / 关闭 |
| 广告模块 | 底部 Anchor 横幅 | 开 / 关 |
| 广告模块 | 插屏（Vignette） | 开 / 关 |

生效延迟：前端 localStorage 镜像 5 分钟、API 层 HTTP 缓存 2 分钟，
访客最长约 5 分钟内看到新配置（新访客即时生效）。

留空的站点参数字段 = 沿用构建期默认文案（各语言文案包），不会被清空成空白。

---

## 改账户 / 改密码

后台「修改账户」区块：填当前密码，再填新账户名、新密码（只改其中一项也可以）。
保存后旧密码立即失效。

---

## 安全设计要点

- 凭据：PBKDF2-SHA256，10 万次迭代，16 字节随机盐，常量时间比较
- 会话：256 bit 随机 token 存 KV（24 小时 TTL）+ `HttpOnly; Secure; SameSite=Strict` cookie
- 登出：会话键立刻覆写为 1 秒 TTL 的失效标记，旧 cookie 不可复用
- 登录限流：每 IP 每分钟 5 次（KV 计数）
- 写操作与改密：校验同源 `Origin`（CSRF 第二道防线）
- 初始化通道：未配 `ADMIN_SETUP_KEY` 时整体关闭（fail-closed）
- 防索引：`noindex` meta + `robots.txt` Disallow + sitemap filter 三重

---

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 打开 /admin/ 只有登录卡，提交报「未登录」或请求 404 | 本地 `npm run preview` 没有 Worker；请在线上域名使用 |
| 初始化报 503「未配置 ADMIN_SETUP_KEY」 | 还没执行第 1 步；执行后访问新版本页面（必要时 `npm run deploy:zh`） |
| 初始化报 401「初始化密钥不正确」 | 填错了；重新 `wrangler secret put` 覆盖 |
| 登录报「管理员尚未初始化」 | 先走首次初始化流程 |
| 忘了密码 | Cloudflare 控制台 → Workers KV → 该 namespace 删除键 `adm:cred`，再到 /admin/ 用引导密钥重新初始化（站点配置 `cfg:site` 不受影响） |
| 忘了账户名 | 同上删 `adm:cred` 重建；或直接删键 `adm:ses:*` 让所有会话下线 |
| 广告开关改了但页面没变 | 访客本地缓存 5 分钟；确认 Ezoic 域名已接入且后台对应格式已开启 |

---

## 存储位置（Cloudflare KV）

与聊天限额共用同一个 namespace（binding `SITE_KV`），键前缀隔离：

| 键 | 内容 | TTL |
|---|---|---|
| `adm:cred` | 管理员账户 + PBKDF2 哈希 + 盐 | 永久 |
| `adm:ses:<token>` | 会话 `{u, exp}` | 24 小时 |
| `adm:rl:<ip>` | 登录尝试计数 | 60 秒 |
| `cfg:site` | 站点配置 JSON | 永久 |

---

## 部署后验证清单

```powershell
# 1) 后台页可访问且不可索引
(Invoke-WebRequest 'https://skill.gautown.top/admin/' -UseBasicParsing).StatusCode   # 200

# 2) 公开配置端点
(Invoke-WebRequest 'https://skill.gautown.top/api/site-config' -UseBasicParsing).Content
# {"site":{},"ads":{"enabled":true,"sideRails":"left","anchor":false,"vignette":false}}

# 3) 未登录访问管理接口应为 401
try { Invoke-WebRequest 'https://skill.gautown.top/api/admin/config' -UseBasicParsing } catch { $_.Exception.Response.StatusCode.value__ }
```

`/api/admin/setup` 在设好密钥前返回 **503**、设好后返回 **401**（错误密钥时），二者都属正常。
配置完成后 `site.name` 等字段出现值即为写入成功。

---

## 本地开发说明

- 静态页面全部可本地 `npm run preview` 预览
- `/api/*` 与 `/admin/` 的登录交互依赖 Cloudflare Worker，本地不可用（设计如此）
- 改 Worker 代码（`src/worker/*.ts`）：`npm test` 跑单测 → 部署时 CI 构建会打包进 Worker
