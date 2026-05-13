import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PUBMED_ESEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const PUBMED_ESUMMARY = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi';
const PUBMED_EFETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';
const SEMANTIC_SCHOLAR = 'https://api.semanticscholar.org/graph/v1/paper/search';

const SEARCH_QUERY = [
  '("Body Image"[Mesh] OR "Body Dysmorphic Disorders"[Mesh]',
  'OR "Physical Appearance, Body"[Mesh]',
  'OR "Feeding and Eating Disorders"[Mesh]',
  'OR "body image"[tiab] OR "body image disturbance"[tiab]',
  'OR "body image concern"[tiab] OR "body dissatisfaction"[tiab]',
  'OR "negative body image"[tiab] OR "body dysmorphic disorder"[tiab]',
  'OR BDD[tiab] OR dysmorphophobia[tiab]',
  'OR "appearance preoccupation"[tiab] OR "appearance anxiety"[tiab]',
  'OR "social appearance anxiety"[tiab] OR "appearance concern"[tiab]',
  'OR "body checking"[tiab] OR "mirror checking"[tiab]',
  'OR "body avoidance"[tiab] OR camouflaging[tiab]',
  'OR "self-objectification"[tiab] OR "objectified body consciousness"[tiab]',
  'OR "muscle dysmorphia"[tiab] OR bigorexia[tiab]',
  'OR "drive for muscularity"[tiab] OR "muscular ideal"[tiab]',
  'OR "physique anxiety"[tiab] OR "exercise dependence"[tiab]',
  'OR "eating disorder"[tiab] OR anorexia[tiab]',
  'OR bulimia[tiab] OR "binge eating"[tiab]',
  'OR "shape concern"[tiab] OR "weight concern"[tiab]',
  'OR "drive for thinness"[tiab] OR "thin ideal"[tiab]',
  'OR "appearance comparison"[tiab] OR "social comparison"[tiab]',
  'OR "body appreciation"[tiab] OR "positive body image"[tiab]',
  'OR "body functionality"[tiab] OR "body neutrality"[tiab]',
  'OR "gender dysphoria"[tiab] OR "body esteem"[tiab]',
  'OR embodiment[tiab] OR interoception[tiab]',
  'OR "body representation"[tiab] OR "body schema"[tiab])',
  'NOT ("body imaging"[tiab] OR "whole-body imaging"[tiab] OR radiograph*[tiab])'
].join(' ');

const S2_QUERIES = [
  'body image body dissatisfaction appearance anxiety',
  'body dysmorphic disorder BDD dysmorphophobia',
  'eating disorder body image anorexia bulimia',
  'muscle dysmorphia drive for muscularity physique anxiety',
  'social media body image appearance comparison self-objectification',
  'body image intervention prevention CBT treatment',
  'body image dermatology cosmetic surgery visible difference'
];

function loadSummarizedPmids(baseDir) {
  const trackFile = join(baseDir, 'data', 'summarized_pmids.json');
  if (existsSync(trackFile)) {
    try {
      const data = JSON.parse(readFileSync(trackFile, 'utf-8'));
      return new Set(Array.isArray(data) ? data : []);
    } catch {
      return new Set();
    }
  }
  return new Set();
}

function getDateRange(daysBack) {
  const now = new Date();
  const from = new Date(now.getTime() - daysBack * 86400000);
  const fmt = d => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  return { from: fmt(from), to: fmt(now) };
}

function sanitizeForXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function searchPubMed(query, dateFrom, dateTo, maxResults = 100) {
  const fullQuery = `${query} AND ("${dateFrom}"[dp] : "${dateTo}"[dp])`;
  const params = new URLSearchParams({
    db: 'pubmed',
    term: fullQuery,
    retmax: String(maxResults),
    retmode: 'json',
    sort: 'date',
    usehistory: 'y'
  });

  console.log(`[PubMed] Searching ${dateFrom} to ${dateTo}...`);
  const res = await fetch(`${PUBMED_ESEARCH}?${params}`, {
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error(`PubMed esearch failed: ${res.status}`);
  const data = await res.json();
  const ids = data.esearchresult?.idlist || [];
  console.log(`[PubMed] Found ${ids.length} PMIDs`);
  return ids;
}

async function fetchPubMedSummary(pmids) {
  if (pmids.length === 0) return {};

  const batchSize = 50;
  const allResults = {};

  for (let i = 0; i < pmids.length; i += batchSize) {
    const batch = pmids.slice(i, i + batchSize);
    const params = new URLSearchParams({
      db: 'pubmed',
      id: batch.join(','),
      retmode: 'json'
    });

    console.log(`[PubMed] Fetching summary batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(pmids.length / batchSize)}...`);
    const res = await fetch(`${PUBMED_ESUMMARY}?${params}`, {
      signal: AbortSignal.timeout(60000)
    });
    if (!res.ok) throw new Error(`PubMed esummary failed: ${res.status}`);
    const data = await res.json();
    const result = data.result || {};

    for (const uid of Object.keys(result)) {
      if (uid === 'uids') continue;
      const entry = result[uid];
      if (entry && entry.title) {
        allResults[uid] = entry;
      }
    }

    if (i + batchSize < pmids.length) {
      await new Promise(r => setTimeout(r, 400));
    }
  }

  return allResults;
}

async function fetchPubMedAbstracts(pmids) {
  if (pmids.length === 0) return {};

  const batchSize = 50;
  const abstracts = {};

  for (let i = 0; i < pmids.length; i += batchSize) {
    const batch = pmids.slice(i, i + batchSize);
    const params = new URLSearchParams({
      db: 'pubmed',
      id: batch.join(','),
      rettype: 'abstract',
      retmode: 'text'
    });

    console.log(`[PubMed] Fetching abstracts batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(pmids.length / batchSize)}...`);
    try {
      const res = await fetch(`${PUBMED_EFETCH}?${params}`, {
        signal: AbortSignal.timeout(60000)
      });
      if (!res.ok) continue;
      const text = await res.text();

      const blocks = text.split(/\n\nPMID:\s*/);
      for (const block of blocks) {
        const pmidMatch = block.match(/^(\d+)/);
        if (!pmidMatch) continue;
        const pmid = pmidMatch[1];
        const lines = block.split('\n');
        let abstractParts = [];
        let inAbstract = false;

        for (const line of lines) {
          if (line.match(/^(BACKGROUND|OBJECTIVE|AIMS|METHODS|RESULTS|CONCLUSION|INTRODUCTION|PURPOSE|DESIGN|SETTING|PARTICIPANTS|MAIN OUTCOME)/i)) {
            inAbstract = true;
            abstractParts.push(line.trim());
          } else if (inAbstract) {
            if (line.match(/^(PMID|DOI|Keywords|MeSH|Full Text)/i) || line.trim() === '') {
              if (line.trim() === '') continue;
              inAbstract = false;
            } else {
              abstractParts.push(line.trim());
            }
          }
        }

        if (abstractParts.length === 0) {
          const absMatch = block.match(/Abstract\s*([\s\S]+?)(?:\n\nPMID|$)/i);
          if (absMatch) {
            abstractParts = [absMatch[1].trim().substring(0, 2000)];
          }
        }

        if (abstractParts.length > 0) {
          abstracts[pmid] = abstractParts.join(' ').substring(0, 2000);
        }
      }
    } catch (e) {
      console.error(`[PubMed] Abstract fetch error: ${e.message}`);
    }

    if (i + batchSize < pmids.length) {
      await new Promise(r => setTimeout(r, 400));
    }
  }

  return abstracts;
}

async function fetchPubMedDetails(pmids) {
  if (pmids.length === 0) return [];

  const summaries = await fetchPubMedSummary(pmids);
  const abstracts = await fetchPubMedAbstracts(pmids);

  const papers = [];
  for (const pmid of pmids) {
    const s = summaries[pmid];
    if (!s) continue;

    const title = (s.title || '').replace(/\.$/, '').trim();
    const abstract = abstracts[pmid] || '';
    if (!title) continue;

    papers.push({
      pmid,
      title,
      journal: s.fulljournalname || s.source || '',
      abstract,
      date: s.pubdate || '',
      authors: (s.authors || []).slice(0, 10).map(a => a.name || '').filter(Boolean),
      doi: (s.elocationid || '').startsWith('doi:') ? s.elocationid.replace('doi:', '').trim() : '',
      keywords: [],
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      source: 'PubMed'
    });
  }

  console.log(`[PubMed] Parsed ${papers.length} papers with details (${papers.filter(p => p.abstract).length} with abstracts)`);
  return papers;
}

async function searchSemanticScholar(query, daysBack = 7) {
  const fromDate = new Date(Date.now() - daysBack * 86400000);
  const fromDateStr = fromDate.toISOString().split('T')[0];

  const params = new URLSearchParams({
    query,
    limit: '30',
    fields: 'paperId,title,abstract,journal,publicationDate,authors,externalIds,url,citationCount',
    publicationDateOrYear: `${fromDateStr}-`
  });

  try {
    console.log(`[S2] Searching: "${query.substring(0, 60)}..."`);
    const res = await fetch(`${SEMANTIC_SCHOLAR}?${params}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) {
      console.log(`[S2] HTTP ${res.status}, skipping`);
      return [];
    }
    const data = await res.json();
    return (data.data || []).map(p => ({
      pmid: p.externalIds?.PubMed || '',
      paperId: p.paperId || '',
      title: p.title || '',
      journal: p.journal?.name || '',
      abstract: (p.abstract || '').substring(0, 2000),
      date: p.publicationDate || '',
      authors: (p.authors || []).slice(0, 10).map(a => a.name),
      doi: p.externalIds?.DOI || '',
      keywords: [],
      url: p.url || `https://www.semanticscholar.org/paper/${p.paperId}`,
      source: 'SemanticScholar',
      citations: p.citationCount || 0
    })).filter(p => p.title && p.abstract && p.abstract.length > 50);
  } catch (e) {
    console.error(`[S2] Error: ${e.message}`);
    return [];
  }
}

function dedupPapers(allPapers, summarizedPmids) {
  const seenTitles = new Set();
  const seenIds = new Set(summarizedPmids);
  const unique = [];

  for (const p of allPapers) {
    const idKey = p.pmid || p.paperId || '';
    const titleKey = p.title.toLowerCase().substring(0, 80);

    if (idKey && seenIds.has(idKey)) continue;
    if (seenTitles.has(titleKey)) continue;

    if (idKey) seenIds.add(idKey);
    seenTitles.add(titleKey);
    unique.push(p);
  }

  return unique;
}

async function main() {
  const daysBack = Math.min(Math.max(parseInt(process.argv[2] || '7'), 1), 30);
  const maxPapers = Math.min(Math.max(parseInt(process.argv[3] || '50'), 1), 100);
  const outputDir = process.argv[4] || '.';

  if (!/^[a-zA-Z0-9._\-\/]+$/.test(outputDir)) {
    throw new Error('Invalid output directory');
  }

  const summarizedPmids = loadSummarizedPmids(outputDir);
  console.log(`[Dedup] Already summarized: ${summarizedPmids.size} PMIDs`);

  const { from, to } = getDateRange(daysBack);

  let pmids = [];
  try {
    pmids = await searchPubMed(SEARCH_QUERY, from, to, 100);
    pmids = pmids.filter(id => !summarizedPmids.has(id));
    console.log(`[PubMed] New PMIDs after dedup: ${pmids.length}`);
  } catch (e) {
    console.error(`[PubMed] Search error: ${e.message}`);
  }

  let pubmedPapers = [];
  if (pmids.length > 0) {
    try {
      pubmedPapers = await fetchPubMedDetails(pmids);
      console.log(`[PubMed] Fetched ${pubmedPapers.length} papers`);
    } catch (e) {
      console.error(`[PubMed] Fetch error: ${e.message}`);
    }
  }

  let s2Papers = [];
  for (const q of S2_QUERIES) {
    try {
      const results = await searchSemanticScholar(q, daysBack);
      s2Papers.push(...results);
      await new Promise(r => setTimeout(r, 1100));
    } catch {
      // continue
    }
  }
  console.log(`[S2] Total: ${s2Papers.length} papers`);

  const allPapers = dedupPapers([...pubmedPapers, ...s2Papers], summarizedPmids);
  const limitedPapers = allPapers.slice(0, maxPapers);

  console.log(`[Final] ${limitedPapers.length} new papers to summarize`);

  const result = {
    date: new Date().toISOString().split('T')[0],
    count: limitedPapers.length,
    pubmed_count: pubmedPapers.length,
    s2_count: s2Papers.length,
    already_summarized: summarizedPmids.size,
    papers: limitedPapers
  };

  const outFile = join(outputDir, 'papers.json');
  writeFileSync(outFile, JSON.stringify(result, null, 2));
  console.log(`[Output] Written to ${outFile}`);
}

main().catch(e => {
  console.error(`[Fatal] ${e.message}`);
  writeFileSync('papers.json', JSON.stringify({ date: new Date().toISOString().split('T')[0], count: 0, papers: [] }));
  process.exit(0);
});
