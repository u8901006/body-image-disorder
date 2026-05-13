import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const DEFAULT_API_BASE = 'https://open.bigmodel.cn/api/paas/v4';
const MODELS = ['GLM-5-Turbo', 'GLM-4.7', 'GLM-4.7-Flash'];
const MAX_TOKENS = 50000;
const TIMEOUT_MS = 480000;
const MAX_RETRIES = 3;

const SYSTEM_PROMPT = `你是一位資深的身體意象 (body image) 與外表相關障礙研究專家，專精於身體意象困擾、身體畸形畏懼症 (BDD)、飲食障礙、肌肉上癮症、社交媒體與外表焦慮等領域的文獻分析。

你的任務是分析提供的學術文獻，並以繁體中文產出結構化的研究日報。

## 輸出格式要求

你必須回傳一個合法的 JSON 物件，格式如下：

{
  "market_summary": "200-400 字的繁體中文整體趨勢摘要，涵蓋研究主題分布、方法學趨勢、臨床意義",
  "top_picks": [
    {
      "rank": 1,
      "emoji": "適合的emoji",
      "title_zh": "繁體中文標題",
      "title_en": "English Title",
      "journal": "期刊名稱",
      "summary": "150-250 字的繁體中文詳細摘要，包含研究背景、方法、主要發現、臨床意義",
      "clinical_utility": "高/中/低",
      "utility_reason": "一句話說明臨床實用性評估理由",
      "pico": {
        "population": "研究對象",
        "intervention": "介入或暴露",
        "comparison": "比較組",
        "outcome": "主要結果"
      },
      "tags": ["標籤1", "標籤2", "標籤3"],
      "pmid": "PMID"
    }
  ],
  "other_papers": [
    {
      "title_zh": "繁體中文標題",
      "title_en": "English Title",
      "journal": "期刊名稱",
      "summary": "80-150 字的繁體中文摘要",
      "tags": ["標籤1"],
      "pmid": "PMID"
    }
  ],
  "topic_distribution": [
    {"topic": "主題名稱（繁中）", "count": 數字}
  ],
  "keywords": ["關鍵詞1", "關鍵詞2"]
}

## 規則

1. 從所有文獻中選出 TOP 5-8 篇最重要、最具臨床或學術價值的論文放入 top_picks
2. 其餘文獻放入 other_papers
3. 每篇 paper 必須有繁體中文標題和摘要
4. clinical_utility 只能是 "高"、"中"、"低" 三個值
5. topic_distribution 列出所有出現的研究主題及其論文數量
6. tags 從以下分類中選擇：身體意象、BDD、飲食障礙、肌肉上癮症、社交媒體、外表焦慮、身體不滿、介入治療、神經科學、心理測量、皮膚/美容、性別認同、兒童青少年、跨文化研究、正向身體意象、體型關注、運動健身
7. 只回傳 JSON，不要加任何 markdown code fence 或說明文字`;

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input' && argv[i + 1]) args.input = argv[i + 1];
    if (argv[i] === '--output' && argv[i + 1]) args.output = argv[i + 1];
  }
  return args;
}

function validatePath(p) {
  if (!p || typeof p !== 'string') return false;
  if (p.includes('..')) return false;
  if (!/^[a-zA-Z0-9._\-\/\\:]+$/.test(p)) return false;
  return true;
}

function loadPapers(inputPath) {
  if (!validatePath(inputPath)) throw new Error('Invalid input path');
  if (!existsSync(inputPath)) throw new Error(`Input file not found: ${inputPath}`);
  const raw = readFileSync(inputPath, 'utf-8');
  const data = JSON.parse(raw);
  return data.papers || [];
}

function robustJSONParse(text) {
  if (!text || typeof text !== 'string') return null;

  let cleaned = text.trim();

  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  cleaned = cleaned.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
  cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, ch => {
    if (ch === '\n' || ch === '\r' || ch === '\t') return ch;
    return '';
  });

  try {
    return JSON.parse(cleaned);
  } catch {
    // continue
  }

  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    const candidate = cleaned.substring(jsonStart, jsonEnd + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // continue
    }

    let fixed = candidate;
    fixed = fixed.replace(/(\w+)\s*:/g, (m, key) => `"${key}":`);
    try {
      return JSON.parse(fixed);
    } catch {
      // continue
    }

    const depthPositions = [];
    let depth = 0;
    let minDepth = Infinity;
    for (let i = 0; i < candidate.length; i++) {
      if (candidate[i] === '{') { depth++; }
      else if (candidate[i] === '}') {
        if (depth <= 2) depthPositions.push(i);
        depth--;
        if (depth <= 1) minDepth = Math.min(minDepth, depth);
      }
    }

    for (const pos of depthPositions.reverse()) {
      const sub = candidate.substring(0, pos + 1);
      try {
        const result = JSON.parse(sub);
        if (result.top_picks || result.other_papers || result.market_summary) {
          return result;
        }
      } catch {
        // continue
      }
    }
  }

  return null;
}

function buildUserPrompt(papers) {
  const paperList = papers.map((p, i) => {
    const authors = (p.authors || []).slice(0, 5).join(', ');
    const kw = (p.keywords || []).join(', ');
    return [
      `[${i + 1}]`,
      `Title: ${p.title}`,
      `Journal: ${p.journal || 'N/A'}`,
      `Date: ${p.date || 'N/A'}`,
      `Authors: ${authors || 'N/A'}`,
      `PMID: ${p.pmid || p.paperId || 'N/A'}`,
      `DOI: ${p.doi || 'N/A'}`,
      `Source: ${p.source || 'N/A'}`,
      kw ? `Keywords: ${kw}` : '',
      `Abstract: ${p.abstract}`
    ].filter(Boolean).join('\n');
  }).join('\n\n---\n\n');

  return `以下是 ${papers.length} 篇最近發表的身體意象相關研究文獻，請分析並生成繁體中文研究日報。\n\n${paperList}`;
}

async function callZhipuAPI(apiKey, apiBase, model, messages) {
  const url = `${apiBase}/chat/completions`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: MAX_TOKENS,
        temperature: 0.7
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`API ${res.status}: ${errBody.substring(0, 200)}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty response from API');
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

async function analyzeWithRetry(apiKey, apiBase, papers) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(papers) }
  ];

  for (const model of MODELS) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[AI] Trying ${model} (attempt ${attempt}/${MAX_RETRIES})...`);
        const raw = await callZhipuAPI(apiKey, apiBase, model, messages);
        const parsed = robustJSONParse(raw);

        if (parsed && (parsed.top_picks || parsed.other_papers || parsed.market_summary)) {
          console.log(`[AI] ${model} succeeded on attempt ${attempt}`);
          return parsed;
        }

        console.log(`[AI] ${model} returned unparseable JSON, retrying...`);
      } catch (e) {
        console.error(`[AI] ${model} attempt ${attempt} failed: ${e.message}`);
        if (e.message.includes('429') || e.message.includes('rate')) {
          const wait = 60 * attempt;
          console.log(`[AI] Rate limited, waiting ${wait}s...`);
          await new Promise(r => setTimeout(r, wait * 1000));
        } else if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 5000 * attempt));
        }
      }
    }
  }

  return null;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDateZh(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（週${weekdays[d.getDay()]}）`;
  } catch {
    return dateStr;
  }
}

function generateHTML(analysis, date) {
  const dateZh = formatDateZh(date);
  const topPicks = analysis.top_picks || [];
  const otherPapers = analysis.other_papers || [];
  const summary = analysis.market_summary || '';
  const topics = analysis.topic_distribution || [];
  const keywords = analysis.keywords || [];

  const maxTopicCount = Math.max(...topics.map(t => t.count), 1);

  const topPicksHTML = topPicks.map(pick => {
    const utilityClass = pick.clinical_utility === '高' ? 'utility-high'
      : pick.clinical_utility === '中' ? 'utility-mid' : 'utility-low';
    const tagsHTML = (pick.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');
    const picoHTML = pick.pico ? `
      <div class="pico-grid">
        <div class="pico-item"><div class="pico-label">P 人口</div><div class="pico-value">${escapeHtml(pick.pico.population || 'N/A')}</div></div>
        <div class="pico-item"><div class="pico-label">I 介入</div><div class="pico-value">${escapeHtml(pick.pico.intervention || 'N/A')}</div></div>
        <div class="pico-item"><div class="pico-label">C 比較</div><div class="pico-value">${escapeHtml(pick.pico.comparison || 'N/A')}</div></div>
        <div class="pico-item"><div class="pico-label">O 結果</div><div class="pico-value">${escapeHtml(pick.pico.outcome || 'N/A')}</div></div>
      </div>` : '';
    const pmid = pick.pmid || '';
    const pmLink = pmid ? `<a class="pubmed-link" href="https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(pmid)}/" target="_blank" rel="noopener">PubMed →</a>` : '';

    return `
      <div class="paper-card" style="animation-delay:${pick.rank * 0.08}s">
        <div class="paper-header">
          <span class="rank-badge">${pick.rank}</span>
          <span class="paper-emoji">${pick.emoji || '📄'}</span>
        </div>
        <div class="paper-title-zh">${escapeHtml(pick.title_zh)}</div>
        <div class="paper-title-en">${escapeHtml(pick.title_en)}${pick.journal ? ' — ' + escapeHtml(pick.journal) : ''}</div>
        <div class="utility-badge ${utilityClass}">臨床實用性：${escapeHtml(pick.clinical_utility || '中')} — ${escapeHtml(pick.utility_reason || '')}</div>
        <div class="paper-summary">${escapeHtml(pick.summary)}</div>
        ${picoHTML}
        <div class="tags-row">${tagsHTML}</div>
        ${pmLink}
      </div>`;
  }).join('');

  const otherPapersHTML = otherPapers.map((paper, i) => {
    const tagsHTML = (paper.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');
    const pmid = paper.pmid || '';
    const pmLink = pmid ? `<a class="pubmed-link" href="https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(pmid)}/" target="_blank" rel="noopener">PubMed →</a>` : '';
    return `
      <div class="other-paper" style="animation-delay:${(i + 1) * 0.05}s">
        <div class="other-title">${escapeHtml(paper.title_zh)}</div>
        <div class="other-meta">${escapeHtml(paper.title_en)}${paper.journal ? ' — ' + escapeHtml(paper.journal) : ''}</div>
        <div class="other-summary">${escapeHtml(paper.summary)}</div>
        <div class="tags-row">${tagsHTML}</div>
        ${pmLink}
      </div>`;
  }).join('');

  const topicBarsHTML = topics.map(t => {
    const pct = Math.round((t.count / maxTopicCount) * 100);
    return `
      <div class="topic-bar-container">
        <div class="topic-bar-label">${escapeHtml(t.topic)} (${t.count})</div>
        <div class="topic-bar-track">
          <div class="topic-bar-fill" style="width:${pct}%">${t.count}</div>
        </div>
      </div>`;
  }).join('');

  const keywordsHTML = keywords.map(k => `<span class="tag">${escapeHtml(k)}</span>`).join('');

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>身體意象研究文獻日報 - ${escapeHtml(dateZh)}</title>
<meta name="description" content="Body Image Disorders Research Daily Report - ${escapeHtml(date)}">
<meta property="og:title" content="身體意象研究文獻日報 ${escapeHtml(dateZh)}">
<meta property="og:description" content="AI 驅動的身體意象研究文獻每日精選">
<meta property="og:type" content="article">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🧠</text></svg>">
<style>
:root{--bg:#f6f1e8;--surface:#fffaf2;--line:#d8c5ab;--text:#2b2118;--muted:#766453;--accent:#8c4f2b;--accent-soft:#ead2bf}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Noto Sans TC','Inter',-apple-system,BlinkMacSystemFont,sans-serif;background:radial-gradient(circle at top,#fff6ea 0,var(--bg) 55%,#ead8c6 100%);color:var(--text);line-height:1.8;min-height:100vh}
.container{max-width:880px;margin:0 auto;padding:40px 20px}
.header{text-align:center;margin-bottom:36px;animation:fadeUp .5s ease-out both}
.header h1{font-size:1.9rem;font-weight:700;color:var(--accent);margin-bottom:6px;letter-spacing:.02em}
.header .subtitle{font-size:.95rem;color:var(--muted);font-weight:400}
.header .date-line{font-size:1.1rem;color:var(--text);margin-top:6px;font-weight:500}
.card{background:var(--surface);border:1px solid var(--line);border-radius:24px;padding:32px;margin-bottom:24px;box-shadow:0 2px 12px rgba(140,79,43,.06);animation:fadeUp .6s ease-out both}
.card h2{font-size:1.35rem;color:var(--accent);margin-bottom:20px;display:flex;align-items:center;gap:8px;font-weight:600}
.paper-card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:24px;margin-bottom:20px;border-left:3px solid var(--accent);animation:fadeUp .5s ease-out both;transition:transform .2s,box-shadow .2s}
.paper-card:hover{transform:translateY(-2px);box-shadow:0 4px 16px rgba(140,79,43,.12)}
.paper-header{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.rank-badge{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;background:var(--accent);color:#fff;border-radius:50%;font-weight:700;font-size:.95rem;flex-shrink:0}
.paper-emoji{font-size:1.3rem}
.paper-title-zh{font-size:1.15rem;font-weight:600;color:var(--text);margin-bottom:4px;line-height:1.6}
.paper-title-en{font-size:.88rem;color:var(--muted);margin-bottom:12px;line-height:1.5}
.paper-summary{font-size:.93rem;color:var(--text);line-height:1.85;margin-bottom:16px}
.utility-badge{display:inline-block;padding:4px 14px;border-radius:999px;font-size:.78rem;font-weight:600;margin-bottom:14px}
.utility-high{background:#e8f5e9;color:#5a7a3a}
.utility-mid{background:#fff8e1;color:#9f7a2e}
.utility-low{background:#f5f5f5;color:var(--muted)}
.pico-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px}
.pico-item{background:rgba(140,79,43,.04);border-radius:12px;padding:12px}
.pico-label{font-size:.78rem;font-weight:600;color:var(--accent);margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em}
.pico-value{font-size:.85rem;color:var(--text);line-height:1.6}
.tags-row{margin-bottom:8px}
.tag{display:inline-block;padding:3px 12px;background:var(--accent-soft);border-radius:999px;font-size:.78rem;color:var(--accent);margin:0 6px 6px 0}
.pubmed-link{display:inline-flex;align-items:center;gap:4px;color:var(--accent);text-decoration:none;font-size:.85rem;font-weight:500;transition:transform .2s}
.pubmed-link:hover{transform:translateX(4px)}
.other-paper{background:rgba(140,79,43,.02);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:14px;animation:fadeUp .4s ease-out both;transition:transform .2s}
.other-paper:hover{transform:translateY(-1px);box-shadow:0 2px 8px rgba(140,79,43,.08)}
.other-title{font-size:1.02rem;font-weight:600;color:var(--text);margin-bottom:3px;line-height:1.5}
.other-meta{font-size:.83rem;color:var(--muted);margin-bottom:10px;line-height:1.4}
.other-summary{font-size:.9rem;color:var(--text);line-height:1.75;margin-bottom:10px}
.topic-bar-container{margin-bottom:14px}
.topic-bar-label{font-size:.9rem;color:var(--text);margin-bottom:5px;font-weight:500}
.topic-bar-track{background:rgba(140,79,43,.08);border-radius:999px;height:26px;overflow:hidden}
.topic-bar-fill{background:linear-gradient(90deg,var(--accent),#c47a4a);border-radius:999px;height:100%;display:flex;align-items:center;padding-left:12px;color:#fff;font-size:.75rem;font-weight:600;transition:width .8s ease;min-width:32px}
.footer-section{text-align:center;margin-top:40px;padding:28px 24px;border-top:1px solid var(--line)}
.footer-section .footer-brand{font-size:1rem;color:var(--accent);font-weight:600;margin-bottom:16px}
.footer-section .footer-links{display:flex;flex-wrap:wrap;justify-content:center;gap:12px;margin-bottom:20px}
.footer-section .footer-links a{display:inline-flex;align-items:center;gap:6px;padding:8px 20px;background:var(--accent-soft);color:var(--accent);text-decoration:none;border-radius:999px;font-size:.88rem;font-weight:500;transition:background .2s,transform .2s}
.footer-section .footer-links a:hover{background:var(--accent);color:#fff;transform:translateY(-1px)}
.footer-section .footer-copy{font-size:.8rem;color:var(--muted);margin-top:8px}
.back-link{display:inline-flex;align-items:center;gap:6px;color:var(--accent);text-decoration:none;font-size:.9rem;font-weight:500;margin-bottom:20px;transition:transform .2s}
.back-link:hover{transform:translateX(-4px)}
@keyframes fadeUp{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}
@media(max-width:600px){
  .container{padding:20px 12px}
  .card{padding:20px;border-radius:16px}
  .paper-card{padding:16px}
  .pico-grid{grid-template-columns:1fr}
  .header h1{font-size:1.5rem}
  .footer-section .footer-links{flex-direction:column;align-items:center}
}
</style>
</head>
<body>
<div class="container">
  <a class="back-link" href="index.html">← 返回總覽</a>

  <div class="header">
    <h1>身體意象研究文獻日報</h1>
    <div class="subtitle">Body Image Disorders Research Daily Report</div>
    <div class="date-line">${escapeHtml(dateZh)}</div>
  </div>

  ${summary ? `
  <div class="card" style="animation-delay:.1s">
    <h2>📊 今日趨勢摘要</h2>
    <div class="paper-summary" style="margin-bottom:0">${escapeHtml(summary)}</div>
  </div>` : ''}

  ${topPicks.length > 0 ? `
  <div class="card" style="animation-delay:.2s">
    <h2>🏆 精選文獻 TOP ${topPicks.length}</h2>
    ${topPicksHTML}
  </div>` : ''}

  ${otherPapers.length > 0 ? `
  <div class="card" style="animation-delay:.3s">
    <h2>📚 其他重要文獻</h2>
    ${otherPapersHTML}
  </div>` : ''}

  ${topics.length > 0 ? `
  <div class="card" style="animation-delay:.35s">
    <h2>📈 主題分布</h2>
    ${topicBarsHTML}
  </div>` : ''}

  ${keywords.length > 0 ? `
  <div class="card" style="animation-delay:.4s">
    <h2>🏷️ 關鍵詞</h2>
    <div class="tags-row">${keywordsHTML}</div>
  </div>` : ''}

  <div class="footer-section">
    <div class="footer-brand">李政洋身心診所</div>
    <div class="footer-links">
      <a href="https://www.leepsyclinic.com/" target="_blank" rel="noopener">🏥 診所首頁</a>
      <a href="https://blog.leepsyclinic.com/" target="_blank" rel="noopener">📬 訂閱電子報</a>
      <a href="https://buymeacoffee.com/CYlee" target="_blank" rel="noopener">☕ Buy me a coffee</a>
    </div>
    <div class="footer-copy">由 AI 自動生成 · GLM-5-Turbo 驅動</div>
  </div>
</div>
</body>
</html>`;
}

function generateBasicHTML(papers, date) {
  const dateZh = formatDateZh(date);
  const paperItems = papers.map((p, i) => {
    const authors = (p.authors || []).slice(0, 5).join(', ');
    return `
      <div class="other-paper" style="animation-delay:${i * 0.05}s">
        <div class="other-title">${escapeHtml(p.title)}</div>
        <div class="other-meta">${escapeHtml(p.journal || '')} · ${escapeHtml(p.date || '')}${authors ? ' · ' + escapeHtml(authors) : ''}</div>
        <div class="other-summary">${escapeHtml(p.abstract?.substring(0, 400) || '')}</div>
        ${p.pmid ? `<a class="pubmed-link" href="https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(p.pmid)}/" target="_blank" rel="noopener">PubMed →</a>` : ''}
      </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>身體意象研究文獻日報 - ${escapeHtml(dateZh)}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🧠</text></svg>">
<style>
:root{--bg:#f6f1e8;--surface:#fffaf2;--line:#d8c5ab;--text:#2b2118;--muted:#766453;--accent:#8c4f2b;--accent-soft:#ead2bf}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Noto Sans TC','Inter',-apple-system,sans-serif;background:radial-gradient(circle at top,#fff6ea 0,var(--bg) 55%,#ead8c6 100%);color:var(--text);line-height:1.8;min-height:100vh}
.container{max-width:880px;margin:0 auto;padding:40px 20px}
.header{text-align:center;margin-bottom:36px;animation:fadeUp .5s ease-out both}
.header h1{font-size:1.9rem;color:var(--accent);margin-bottom:6px}
.header .subtitle{color:var(--muted);font-size:.95rem}
.header .date-line{font-size:1.1rem;color:var(--text);margin-top:6px;font-weight:500}
.card{background:var(--surface);border:1px solid var(--line);border-radius:24px;padding:32px;margin-bottom:24px;box-shadow:0 2px 12px rgba(140,79,43,.06);animation:fadeUp .6s ease-out both}
.card h2{font-size:1.35rem;color:var(--accent);margin-bottom:20px}
.other-paper{background:rgba(140,79,43,.02);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:14px;animation:fadeUp .4s ease-out both}
.other-title{font-size:1.02rem;font-weight:600;color:var(--text);margin-bottom:3px}
.other-meta{font-size:.83rem;color:var(--muted);margin-bottom:10px}
.other-summary{font-size:.9rem;color:var(--text);line-height:1.75;margin-bottom:10px}
.pubmed-link{color:var(--accent);text-decoration:none;font-size:.85rem;font-weight:500}
.pubmed-link:hover{text-decoration:underline}
.footer-section{text-align:center;margin-top:40px;padding:28px 24px;border-top:1px solid var(--line)}
.footer-section .footer-brand{font-size:1rem;color:var(--accent);font-weight:600;margin-bottom:16px}
.footer-section .footer-links{display:flex;flex-wrap:wrap;justify-content:center;gap:12px;margin-bottom:20px}
.footer-section .footer-links a{display:inline-flex;align-items:center;gap:6px;padding:8px 20px;background:var(--accent-soft);color:var(--accent);text-decoration:none;border-radius:999px;font-size:.88rem;font-weight:500;transition:background .2s}
.footer-section .footer-links a:hover{background:var(--accent);color:#fff}
.footer-section .footer-copy{font-size:.8rem;color:var(--muted)}
.back-link{display:inline-flex;align-items:center;gap:6px;color:var(--accent);text-decoration:none;font-size:.9rem;font-weight:500;margin-bottom:20px}
@keyframes fadeUp{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}
@media(max-width:600px){.container{padding:20px 12px}.card{padding:20px;border-radius:16px}.header h1{font-size:1.5rem}}
</style>
</head>
<body>
<div class="container">
  <a class="back-link" href="index.html">← 返回總覽</a>
  <div class="header">
    <h1>身體意象研究文獻日報</h1>
    <div class="subtitle">Body Image Disorders Research Daily Report</div>
    <div class="date-line">${escapeHtml(dateZh)}</div>
  </div>
  <div class="card">
    <h2>📚 今日文獻（${papers.length} 篇）</h2>
    ${paperItems}
  </div>
  <div class="footer-section">
    <div class="footer-brand">李政洋身心診所</div>
    <div class="footer-links">
      <a href="https://www.leepsyclinic.com/" target="_blank" rel="noopener">🏥 診所首頁</a>
      <a href="https://blog.leepsyclinic.com/" target="_blank" rel="noopener">📬 訂閱電子報</a>
      <a href="https://buymeacoffee.com/CYlee" target="_blank" rel="noopener">☕ Buy me a coffee</a>
    </div>
    <div class="footer-copy">由 AI 自動生成（基礎版）</div>
  </div>
</div>
</body>
</html>`;
}

function updateSummarizedPmids(papers, baseDir) {
  const dataDir = join(baseDir, 'data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const trackFile = join(dataDir, 'summarized_pmids.json');
  let existing = [];
  if (existsSync(trackFile)) {
    try {
      existing = JSON.parse(readFileSync(trackFile, 'utf-8'));
      if (!Array.isArray(existing)) existing = [];
    } catch {
      existing = [];
    }
  }

  const existingSet = new Set(existing);
  for (const p of papers) {
    const id = p.pmid || p.paperId;
    if (id && !existingSet.has(id)) {
      existing.push(id);
    }
  }

  writeFileSync(trackFile, JSON.stringify(existing, null, 2));
  console.log(`[Track] Updated: ${existing.length} total summarized PMIDs`);
}

async function main() {
  const args = parseArgs();
  const inputPath = args.input || 'papers.json';
  const outputPath = args.output || 'docs/body-image-report.html';

  if (!validatePath(inputPath)) throw new Error('Invalid input path');
  if (!validatePath(outputPath)) throw new Error('Invalid output path');

  const papers = loadPapers(inputPath);
  console.log(`[Report] ${papers.length} papers to process`);

  if (papers.length === 0) {
    console.log('[Report] No papers found, skipping report generation');
    process.exit(0);
  }

  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) {
    console.error('[Report] ZHIPU_API_KEY not set, generating basic report');
    const dateMatch = inputPath.match(/(\d{4}-\d{2}-\d{2})/);
    const date = dateMatch ? dateMatch[1] : new Date().toISOString().split('T')[0];
    const html = generateBasicHTML(papers, date);
    const outDir = dirname(outputPath);
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    writeFileSync(outputPath, html);
    updateSummarizedPmids(papers, '.');
    console.log(`[Report] Basic report written to ${outputPath}`);
    return;
  }

  const apiBase = process.env.ZHIPU_API_BASE || DEFAULT_API_BASE;

  const dateMatch = outputPath.match(/(\d{4}-\d{2}-\d{2})/);
  const date = dateMatch ? dateMatch[1] : new Date().toISOString().split('T')[0];

  const analysis = await analyzeWithRetry(apiKey, apiBase, papers);

  const outDir = dirname(outputPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  if (analysis) {
    const html = generateHTML(analysis, date);
    writeFileSync(outputPath, html);
    console.log(`[Report] Full AI report written to ${outputPath}`);
  } else {
    const html = generateBasicHTML(papers, date);
    writeFileSync(outputPath, html);
    console.log(`[Report] Fallback basic report written to ${outputPath}`);
  }

  updateSummarizedPmids(papers, '.');
}

main().catch(e => {
  console.error(`[Fatal] ${e.message}`);
  process.exit(1);
});
