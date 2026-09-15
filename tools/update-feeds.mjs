#!/usr/bin/env node
/**
 * tools/update-feeds.mjs —— 抓取每个博客的 RSS/Atom，把最新一篇的发布时间写回 data/blogs.json
 *
 * 由 .github/workflows/update-feeds.yml 每天定时运行，也可以本地手动跑：
 *   node tools/update-feeds.mjs            # 写入
 *   node tools/update-feeds.mjs --dry-run  # 只打印将要发生的改动，不写文件
 *
 * 设计原则（都很保守，宁可不动数据，也不要写坏数据）：
 *   - 只写 updated / feedOk / feedError 三个字段，其它字段原样保留
 *   - 抓取失败时保留原来的 updated，只记录 feedError，绝不把好数据清空
 *   - 连续失败不会自动标记 dormant —— 那需要人来判断，脚本不擅自改 status
 *   - 解析不出日期就不动，不猜
 *   - 没有任何改动时以退出码 0 结束，让 workflow 跳过 commit
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_PATH = join(ROOT, 'data', 'blogs.json');

const DRY_RUN = process.argv.includes('--dry-run');
const CONCURRENCY = 5;
const TIMEOUT_MS = 15000;
const MAX_BYTES = 400_000;      // 只读前 400KB，避免撞上巨型 feed
const UA = 'BlogExchangeAssociation-bot/1.0 (+https://blogexchangeassociation.github.io/)';

/* ------------------------------------------------------------------ */
/* XML 解析：只用正则，不引第三方依赖                                    */
/* ------------------------------------------------------------------ */

/** 取出某个标签的文本内容（取第一个匹配） */
function tagText(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const m = xml.match(re);
  if (!m) return null;
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim();
}

/** 按优先级找日期：Atom 的 <updated> 在 feed 级别，entry 级别优先 published */
function extractLatestDate(xml) {
  const isAtom = /<feed[\s>]/i.test(xml.slice(0, 2000));
  const candidates = [];

  if (isAtom) {
    // Atom：逐个 <entry> 找 <published> 或 <updated>
    const entries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
    for (const e of entries) {
      const d = tagText(e, 'published') || tagText(e, 'updated');
      if (d) candidates.push(d);
    }
    if (!candidates.length) {
      const d = tagText(xml, 'updated');   // feed 级别的 updated
      if (d) candidates.push(d);
    }
  } else {
    // RSS 2.0：逐个 <item> 找 <pubDate> 或 <dc:date>
    const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
    for (const it of items) {
      const d = tagText(it, 'pubDate') || tagText(it, 'dc:date') || tagText(it, 'published');
      if (d) candidates.push(d);
    }
    if (!candidates.length) {
      const d = tagText(xml, 'lastBuildDate') || tagText(xml, 'pubDate');
      if (d) candidates.push(d);
    }
  }

  const times = candidates
    .map((s) => Date.parse(s))
    .filter((t) => !Number.isNaN(t) && t > 0);

  if (!times.length) return null;
  return new Date(Math.max(...times));
}

const toISODate = (d) => d.toISOString().slice(0, 10);

/* ------------------------------------------------------------------ */
/* 抓取                                                                */
/* ------------------------------------------------------------------ */

async function fetchFeed(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml, */*' }
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    const buf = await res.arrayBuffer();
    const xml = new TextDecoder('utf-8').decode(buf.slice(0, MAX_BYTES));
    const date = extractLatestDate(xml);
    if (!date) return { ok: false, error: '未能从 feed 中解析出日期' };
    return { ok: true, date };
  } catch (err) {
    const msg = err?.name === 'AbortError' ? `超时（>${TIMEOUT_MS / 1000}s）` : (err?.message || String(err));
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** 简易并发池 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const blogs = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
if (!Array.isArray(blogs)) throw new Error('data/blogs.json 的顶层必须是数组');

const targets = blogs
  .map((b, index) => ({ b, index }))
  .filter(({ b }) => typeof b?.feed === 'string' && /^https?:\/\//i.test(b.feed));

console.log(`共 ${blogs.length} 条数据，其中 ${targets.length} 条提供了 feed，开始抓取…\n`);

const results = await mapLimit(targets, CONCURRENCY, async ({ b, index }) => {
  const r = await fetchFeed(b.feed);
  return { index, name: b.name, ...r };
});

let changed = 0;
const lines = [];

for (const r of results) {
  const b = blogs[r.index];
  const prevUpdated = b.updated || '(空)';

  if (r.ok) {
    const next = toISODate(r.date);
    const isNewer = !b.updated || Date.parse(next) > Date.parse(b.updated);
    // 只在日期确实推进时才写，避免无意义的每日 diff
    if (isNewer || b.feedOk !== true || b.feedError) {
      b.updated = next;
      b.feedOk = true;
      delete b.feedError;
      changed++;
      lines.push(`  ✓ ${r.name}：${prevUpdated} → ${next}`);
    }
  } else {
    // 失败：保留原 updated，只记录错误
    if (b.feedError !== r.error) {
      b.feedError = r.error;
      changed++;
      lines.push(`  ✗ ${r.name}：抓取失败（${r.error}），保留 updated = ${prevUpdated}`);
    }
  }
}

console.log(lines.length ? lines.join('\n') : '  所有 feed 均无变化。');
console.log(`\n需要写入的改动：${changed} 处`);

if (!changed) {
  console.log('没有变化，退出。');
  process.exit(0);
}

if (DRY_RUN) {
  console.log('（--dry-run，未写入文件）');
  process.exit(0);
}

writeFileSync(DATA_PATH, JSON.stringify(blogs, null, 2) + '\n');
console.log('已写入 data/blogs.json');
