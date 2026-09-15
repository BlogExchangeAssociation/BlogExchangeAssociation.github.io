#!/usr/bin/env node
/**
 * tools/build.mjs —— 从 data/blogs.json 生成/校验派生文件
 *
 * 这个脚本只在本地或 CI 里运行，站点运行时不需要它。
 * 它做三件事：
 *   1. 把 <noscript> 里的博客清单写进 index.html（无 JS 兜底，利于 SEO 与分享预览）
 *   2. 生成 sitemap.xml
 *   3. 抽出 index.html 内联的 <script> 做一次语法检查，并统计体积
 *
 * 用法：
 *   node tools/build.mjs            # 写入
 *   node tools/build.mjs --check    # 只检查是否与 blogs.json 同步（CI 用），有差异则退出码 1
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML_PATH = join(ROOT, 'index.html');
const DATA_PATH = join(ROOT, 'data', 'blogs.json');
const SITEMAP_PATH = join(ROOT, 'sitemap.xml');

const SITE_URL = 'https://blogexchangeassociation.github.io';
const CHECK = process.argv.includes('--check');

const NS_START = '<!-- build:noscript:start -->';
const NS_END = '<!-- build:noscript:end -->';
const SCRIPT_START = '<!-- build:script:start -->';
const SCRIPT_END = '<!-- build:script:end -->';

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 替换两个标记之间的内容；标记缺失时抛错，避免静默失效 */
function replaceBetween(source, startMarker, endMarker, body, label) {
  const i = source.indexOf(startMarker);
  const j = source.indexOf(endMarker);
  if (i === -1 || j === -1 || j < i) {
    throw new Error(`index.html 里找不到 ${label} 的标记（${startMarker} … ${endMarker}）`);
  }
  return source.slice(0, i + startMarker.length) + '\n' + body + '\n' + source.slice(j);
}

/** 抽出所有内联 <script>（排除 src= 的外链与 type= 的非 JS 块） */
function inlineScripts(html) {
  const out = [];
  const re = /<script(?![^>]*\bsrc=)(?![^>]*\btype=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

/* ------------------------------------------------------------------ */
/* 1. 读取数据                                                         */
/* ------------------------------------------------------------------ */

const blogs = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
if (!Array.isArray(blogs)) throw new Error('data/blogs.json 的顶层必须是数组');

const active = blogs.filter((b) => b && b.status !== 'dormant');
const dormant = blogs.filter((b) => b && b.status === 'dormant');

/* ------------------------------------------------------------------ */
/* 2. 生成 noscript 兜底清单                                           */
/* ------------------------------------------------------------------ */

const STATIC_LIMIT = 60;   // 超过这个数量就不再往 HTML 里塞，避免首页体积失控

function noscriptBody() {
  const shown = active.slice(0, STATIC_LIMIT);
  const rows = shown.map((b) => {
    const meta = [b.author, b.tech].filter(Boolean).join(' · ');
    return `          <li><a href="${esc(b.url)}" target="_blank" rel="noopener noreferrer">${esc(b.name)}</a>` +
           (meta ? ` <span class="text-[#8a9694]">— ${esc(meta)}</span>` : '') +
           (b.description ? `<br><span class="text-[#8a9694]">${esc(b.description)}</span>` : '') +
           `</li>`;
  }).join('\n');

  const more = active.length > shown.length
    ? `\n        <p class="mt-3 text-[#8a9694]">……以及另外 ${active.length - shown.length} 个博客，` +
      `完整数据见 <a href="./data/blogs.json">data/blogs.json</a>。</p>`
    : '';

  return `      <!-- 本段由 tools/build.mjs 从 data/blogs.json 自动生成，请勿手工编辑 -->
      <div class="rounded-xl border border-[#efe4da] bg-white p-4 dark:border-[#333333] dark:bg-[#242427]">
        <p class="text-sm font-medium text-[#1f2d2b] dark:text-[#dadadb]">
          你的浏览器未启用 JavaScript，因此搜索与筛选不可用。以下是本站收录的 ${active.length} 个博客：
        </p>
        <ul class="mt-3 space-y-2 text-sm text-[#5c6b69] dark:text-[#9b9c9d]">
${rows}
        </ul>${more}
      </div>`;
}

/* ------------------------------------------------------------------ */
/* 3. 生成 sitemap.xml                                                 */
/* ------------------------------------------------------------------ */

function sitemap() {
  const lastmod = blogs
    .map((b) => b.updated)
    .filter(Boolean)
    .sort()
    .pop();

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE_URL}/</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''}
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`;
}

/* ------------------------------------------------------------------ */
/* 4. 应用改动                                                         */
/* ------------------------------------------------------------------ */

const originalHtml = readFileSync(HTML_PATH, 'utf8');
const nextHtml = replaceBetween(originalHtml, NS_START, NS_END, noscriptBody(), 'noscript 兜底');
const nextSitemap = sitemap();
const originalSitemap = existsSync(SITEMAP_PATH) ? readFileSync(SITEMAP_PATH, 'utf8') : '';

const htmlChanged = nextHtml !== originalHtml;
const sitemapChanged = nextSitemap !== originalSitemap;

/* ------------------------------------------------------------------ */
/* 5. 内联脚本语法检查 + 体积统计                                      */
/* ------------------------------------------------------------------ */

const scripts = inlineScripts(nextHtml);
let syntaxError = null;
for (let i = 0; i < scripts.length; i++) {
  const file = join(ROOT, `.build-check-${i}.js`);
  writeFileSync(file, scripts[i]);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    syntaxError = `第 ${i + 1} 段内联脚本语法错误：\n${err.stderr?.toString() || err.message}`;
  } finally {
    try { unlinkSync(file); } catch { /* 清理失败不影响结果 */ }
  }
}

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log(`博客总数     : ${blogs.length}（正常 ${active.length} / 异常 ${dormant.length}）`);
console.log(`index.html   : ${kb(Buffer.byteLength(nextHtml))}${htmlChanged ? '（需更新）' : '（已是最新）'}`);
console.log(`sitemap.xml  : ${kb(Buffer.byteLength(nextSitemap))}${sitemapChanged ? '（需更新）' : '（已是最新）'}`);
console.log(`内联脚本     : ${scripts.length} 段，共 ${kb(scripts.reduce((s, x) => s + Buffer.byteLength(x), 0))}`);

if (syntaxError) {
  console.error('\n' + syntaxError);
  process.exit(1);
}
console.log('内联脚本语法 : 通过');

if (CHECK) {
  if (htmlChanged || sitemapChanged) {
    console.error('\n派生文件与 data/blogs.json 不同步，请运行：node tools/build.mjs');
    process.exit(1);
  }
  console.log('同步检查     : 通过');
} else {
  if (htmlChanged) writeFileSync(HTML_PATH, nextHtml);
  if (sitemapChanged) writeFileSync(SITEMAP_PATH, nextSitemap);
  console.log(htmlChanged || sitemapChanged ? '\n已写入更新。' : '\n无需改动。');
}
