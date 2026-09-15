# 博客交流协会 · 独立博客导航

群友独立博客的收录与展示站点，托管在 GitHub Pages：
**https://blogexchangeassociation.github.io**

## 怎么加一个博客

只需要改 `data/blogs.json`，在数组里加一条：

```json
{
  "name": "博客名称",
  "url": "https://example.com",
  "author": "作者名",
  "description": "一句话介绍这个博客",
  "tags": ["技术", "生活"],
  "tech": "Hexo",
  "feed": "https://example.com/atom.xml",
  "message": "为什么写博客，一句话",
  "added": "2026-09-15",
  "updated": "2026-09-15",
  "featured": false
}
```

### 字段说明

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | ✅ | 博客名称。缺了这条数据会被整条忽略 |
| `url` | ✅ | 博客地址，**必须**以 `https://` 或 `http://` 开头，否则会被安全校验丢弃 |
| `author` | | 作者名，缺省为「匿名」 |
| `description` | | 一句话简介。写得好很重要 —— 读者主要靠它决定点不点 |
| `tags` | | 标签数组，自由词表。界面会按出现频次排序并显示计数 |
| `tech` | | **技术栈**：`Hexo` / `Typecho` / `Hugo` / `WordPress` / `Astro` / `Halo` 等。这是本站区别于同类导航站的筛选维度，建议都填 |
| `feed` | | RSS / Atom 地址。填了才能被每天自动更新 `updated` |
| `message` | | 「寄语」，一句话。会在「随机逛逛」里展示。比简介更打动人 |
| `added` | | 加入协会的日期 `YYYY-MM-DD`，用于「最近加入」排序 |
| `updated` | | 最近更新日期 `YYYY-MM-DD`。**通常不用手填**，由 Action 自动抓 RSS 写入 |
| `featured` | | `true` 会在「推荐优先」排序里置顶 |
| `status` | | `"dormant"` 表示失联 / 长期不更，会被移出主列表、放进「异常名录」 |
| `avatar` | | 头像图片地址（可选）。不填会用博客名首字自动生成色块 |

改完之后跑一下同步脚本，把无 JS 兜底清单和 sitemap 一起更新：

```bash
node tools/build.mjs
```

然后提交推送，1～2 分钟后线上生效：

```bash
git add -A && git commit -m "新增博客：XXX" && git push
```

## 仓库结构

```
index.html                       站点全部代码（HTML + CSS + 原生 JS，约 55 KB）
data/blogs.json                  唯一的数据源，所有博客都在这里
sitemap.xml                      由 build.mjs 生成
tools/build.mjs                  从 blogs.json 生成 noscript 兜底与 sitemap，并检查 JS 语法
tools/update-feeds.mjs           抓取各博客 RSS，把最新一篇的日期写回 updated
.github/workflows/update-feeds.yml   每天定时运行上面的脚本
docs/design-v2.md                设计方案与同类站点调研
```

**运行时只有两个文件**：浏览器只会加载 `index.html` 和 `data/blogs.json`。
`tools/` 与 `.github/` 只影响仓库，不影响站点的静态本质 —— 没有后端，没有打包工具，没有构建产物。

## 自动更新新鲜度

`.github/workflows/update-feeds.yml` 每天北京时间 12:00 运行一次：

1. 读取 `data/blogs.json`，逐个请求 `feed` 字段里的 RSS / Atom
2. 解析出最新一篇的发布时间，写回 `updated`
3. 抓取失败时**保留**原来的 `updated`，只在 `feedError` 里记录原因（不会把好数据清空）
4. 重新生成 noscript 兜底与 sitemap，然后自动 commit

连续失败**不会**自动标记 `dormant` —— 那需要人来判断，脚本不擅自改 `status`。
把某个博客移入异常名录是手工操作：给它加上 `"status": "dormant"`。

本地手动跑：

```bash
node tools/update-feeds.mjs --dry-run   # 只看会发生什么，不写文件
node tools/update-feeds.mjs             # 真的写入
```

## 本地预览

`fetch` 在 `file://` 协议下会被浏览器拦截，所以**不要直接双击 index.html**，
起一个临时服务：

```bash
python3 -m http.server 8000
# 打开 http://127.0.0.1:8000
```

（直接双击打开时页面会显示「博客数据加载失败 Failed to fetch」而不是白屏，这是有意的兜底提示。）

## 接评论区（Giscus）

`index.html` 里已预留写好但被注释掉的 Giscus 初始化代码。步骤：

1. 仓库 **Settings → General → Features** 勾选 **Discussions**
2. 到 https://github.com/apps/giscus 把 App 安装到本仓库（仓库必须是 public）
3. 新建一个 Discussion 分类，类型选 **公告 / Announcements**
4. 打开 https://giscus.app/zh-CN 填仓库名，把生成的 `data-repo-id` 与 `data-category-id` 复制出来
5. 在 `index.html` 里取消那段代码的注释，替换掉 `R_xxxxxxxx` / `DIC_xxxxxxxx`
6. `node tools/build.mjs && git push`

那段代码已处理主题联动：页面切深色时评论框也会跟着切。

## 部署

仓库 Settings → Pages → Source 选 **Deploy from a branch**，分支选 `main`，目录选 `/(root)`。
推送到 `main` 即自动发布。不需要 `.nojekyll`：Jekyll 默认只跳过 `_`、`.`、`#` 开头的路径，
`data/` 目录会被原样复制并以 `application/json` 正常返回。

## 设计说明

配色与信息架构的取舍、同类站点调研结论，见 `docs/design-v2.md`。
简单说：单列列表优先（同质化内容用卡片墙会切碎版面）、暖白底 + 墨绿正文 + 砖橙单主色
（避免模板站的渐变观感）、用更新时间和「勤更榜」证明这个目录是活的。
