# 评论功能（Giscus）

详情页的「讨论」tab，基于 [Giscus](https://github.com/giscus/giscus)，评论数据存放在
**GitHub Discussions**，站点本身不存储任何用户数据。

## 接入前提

| 条件 | 状态 |
| --- | --- |
| 仓库必须为 **public** | ✓ 已转 public（私有仓库的 Discussions 匿名不可读，只有协作者能评论） |
| 仓库开启 **Discussions** | ✓ 已开启 |
| 一个讨论分类 | ✓ 使用默认的 General |

## 实现要点

### 每个 skill 一个独立讨论，中英共享

```
mapping = specific
term    = skill id（如 pdf、docx）
```

选 `specific` 而不是 `pathname`：中英两页路径不同（`/skills/pdf` 与 `/en/skills/pdf`），
用 `pathname` 会让同一个 skill 产生两个重复讨论；用 skill id 则两页共享同一个讨论。

### 懒加载

站内详情页共 **17,860 个**（中英各8,923）。若每页首屏都注入 Giscus 客户端脚本
（约 50 KB）会显著拖慢加载。这里改为：

```
点开「讨论」tab → 才注入 giscus.app/client.js
```

未点开的页面零开销。构建产物中不含任何 `<script src="https://giscus.app/...">` 可验证这一点。

### strict 模式

`data-strict="1"`：仅在配置域名（`skill.gautown.top`）下加载。
本地 `npm run dev` 与预览环境不会产生评论，避免在 Discussions 里堆出无用讨论。

### 其他配置

| 参数 | 值 | 说明 |
| --- | --- | --- |
| `data-theme` | `preferred_color_scheme` | 跟随系统明暗，与站点主题切换不冲突（Giscus 在 iframe 内） |
| `data-lang` | `zh-CN` / `en` | 跟随页面语言 |
| `data-loading` | `lazy` | Giscus 自身的懒加载 |
| `data-reactions-enabled` | `1` | 开启表情回复 |

### 深链与降级

- `页面 URL#discussion` 可直接打开讨论 tab（如 `https://skill.gautown.top/skills/pdf#discussion`）
- 禁用 JS 时 `<noscript>` 显示「前往 GitHub 讨论」的链接

## 配置值的位置

`src/components/GiscusComments.astro` 中的 `repo-id` 与 `category-id` 是 GitHub 的
node ID，在 https://giscus.app 上配置时会自动生成。

```
repoId     R_kgDOVEdjJA
categoryId DIC_kwDOVEdjJM4DH_Vd  (General)
```

若更换仓库或分类，需同步更新这两个值。

## 注意事项

**评论等于在 GitHub 上发帖。** 用户必须有 GitHub 账号才能评论，且评论是公开可见的。
如果站上出现不友善内容，处理方式是直接在 Discussions 里删除或锁定该讨论。

**不会产生大量空讨论。** Giscus 采用「首次访问才创建」策略，且 strict 模式限制了域名，
所以只有真正访问过某个 skill 讨论页的用户才会创建对应讨论。

## 与点赞/投票的区别

站点详情页侧栏还有点赞 ♡ 与投票 ↑↓，它们是**纯前端 localStorage**，只对当前设备有效，
与本评论功能无关（且仅本地30 个精选 skill 有数据）。