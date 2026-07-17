const log = require('../utils/logger');
/**
 * Academic Source Intelligence Layer  (v3)
 *
 * Source priority and allocation:
 *   ≥ 60%  OpenAlex + Semantic Scholar  (primary academic, free APIs)
 *   10-20% ArXiv                         (preprints, cutting-edge technical work)
 *   ≤ 30%  Web crawler                   (recent only; older sources tagged goldStandard)
 *
 * MCP paper-search bridge: when the Python MCP server is running (auto-started),
 * fetchViaMCP() is used as an enrichment pass over OpenAlex + arXiv + Semantic Scholar
 * together, avoiding duplicate HTTP round-trips.
 *
 * Per-query limits are owned by the orchestrator (Nature×Depth config).
 * This service fetches exactly what it is told.
 */

const axios = require('axios');
const cheerio = require('cheerio');
const { spawn } = require('child_process');
const path = require('path');
const semanticScholarService = require('./semanticScholarService');

// ── MCP paper-search Python server bridge ─────────────────────────────────
const MCP_SERVER_PATH = path.join(__dirname, '../rag_service/paper_search_mcp.py');
const PYTHON_BIN = process.env.PAPER_MCP_PYTHON || 'python3';

/**
 * Call the Python paper-search MCP server via its JSON-RPC / tool interface.
 * We launch a short-lived subprocess for each batch call (the server exits
 * after returning the result over STDIO).
 *
 * Protocol: FastMCP 3.x in STDIO mode responds to the MCP `tools/call` message.
 * We send one request and collect the full response.
 */
async function _callMcpTool(toolName, toolArgs, timeoutMs = 25000) {
    return new Promise((resolve, reject) => {
        const proc = spawn(PYTHON_BIN, [MCP_SERVER_PATH], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
        });

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', d => { stdout += d.toString(); });
        proc.stderr.on('data', d => { stderr += d.toString(); });

        const timer = setTimeout(() => {
            proc.kill();
            reject(new Error(`MCP tool '${toolName}' timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        proc.on('close', code => {
            clearTimeout(timer);
            // FastMCP writes JSON-RPC responses to stdout.
            // Parse the LAST complete JSON line that contains a 'result'.
            try {
                const lines = stdout.split('\n').filter(Boolean);
                for (let i = lines.length - 1; i >= 0; i--) {
                    try {
                        const msg = JSON.parse(lines[i]);
                        if (msg.result !== undefined) {
                            // result.content is [{type:'text',text:'[...]'}]
                            const content = msg.result?.content;
                            if (Array.isArray(content) && content[0]?.text) {
                                resolve(JSON.parse(content[0].text));
                            } else {
                                resolve(msg.result);
                            }
                            return;
                        }
                    } catch { /* keep scanning */ }
                }
                reject(new Error(`MCP: no result in response. stderr=${stderr.slice(0, 200)}`));
            } catch (e) {
                reject(new Error(`MCP parse error: ${e.message}`));
            }
        });

        // Send MCP initialize + tools/call in one STDIO write
        const initMsg = JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'imentor', version: '1.0' } }
        });
        const callMsg = JSON.stringify({
            jsonrpc: '2.0', id: 2, method: 'tools/call',
            params: { name: toolName, arguments: toolArgs }
        });
        proc.stdin.write(initMsg + '\n');
        proc.stdin.write(callMsg + '\n');
        proc.stdin.end();
    });
}

/**
 * Fetch papers via MCP server — combines arXiv + OpenAlex + Semantic Scholar
 * in a single Python call, normalises into the same shape as existing sources.
 */
async function fetchViaMCP(query, options = {}) {
    const limit = options.limit || 8;
    const source = options.source || 'openalex'; // 'arxiv' | 'openalex' | 'semantic_scholar'

    const toolMap = {
        arxiv:            { tool: 'search_arxiv',            args: { query, max_results: limit } },
        openalex:         { tool: 'search_openalex',         args: { query, max_results: limit, open_access_only: true } },
        semantic_scholar: { tool: 'search_semantic_scholar', args: { query, max_results: limit } },
    };

    const { tool, args } = toolMap[source] || toolMap.openalex;

    try {
        const papers = await _callMcpTool(tool, args, 28000);
        if (!Array.isArray(papers)) return [];

        // Normalise to academicSourceService shape
        return papers.map(p => ({
            title:             p.title || 'Untitled',
            authors:           Array.isArray(p.authors) ? p.authors : [],
            year:              p.year || null,
            abstract:          p.abstract || p.tldr || '',
            content:           p.abstract || p.tldr || '',
            doi:               p.doi || null,
            url:               p.oa_url || p.pdf_url || null,
            pdf_url:           p.pdf_url || p.oa_url || null,
            arxivId:           p.arxiv_id || (p.id?.includes('arxiv') ? p.id : null),
            citationCount:     0,
            isOpenAccess:      p.is_oa !== false,
            tldr:              p.tldr || null,
            sourceProvider:    p.source || source,
            credibilityBaseScore: source === 'openalex' ? 85 : source === 'semantic_scholar' ? 82 : 78,
        }));
    } catch (err) {
        log.warn('RESEARCH', `[MCP] fetchViaMCP(${source}) failed: ${err.message} — falling back to direct API`);
        return [];
    }
}

const OPENALEX_API = 'https://api.openalex.org/works';
const ARXIV_API    = 'http://export.arxiv.org/api/query';

// ── Trusted publisher allow-list for deep research ────────────────────────────
// Only papers from these publishers pass the quality gate.
// arXiv is included but requires a minimum citation count.
const TRUSTED_PUBLISHERS = {
    // OpenAlex host_organization canonical names (lower-cased for matching)
    openalex: [
        'ieee',
        'institute of electrical and electronics engineers',
        'elsevier',
        'springer',
        'springer nature',
        'sciencedirect',
        'science direct',
        'nature',
        'american chemical society',   // safety net
        'acm',                         // safety net
    ],
    // arXiv papers must have at least this many citations
    arxivMinCitations: 18,
};

/**
 * Filter a list of sources to only include trusted publishers.
 * - OpenAlex / Semantic Scholar sources: keep if publisher matches allow-list.
 * - arXiv sources: keep if citationCount >= ARXIV_MIN_CITATIONS.
 * - Sources without publisher info pass through (don't discard on missing data).
 *
 * @param {object[]} sources
 * @param {boolean}  [strict=true]  if false, unknown publishers are kept (soft mode)
 * @returns {object[]}
 */
function applyPublisherGate(sources, strict = true) {
    const allowed = TRUSTED_PUBLISHERS.openalex;
    const minCit  = TRUSTED_PUBLISHERS.arxivMinCitations;

    return sources.filter(s => {
        const provider = (s.sourceProvider || '').toLowerCase();

        // arXiv: citation gate
        if (provider === 'arxiv') {
            const citations = s.citationCount || 0;
            const pass = citations >= minCit;
            if (!pass) {
                log.debug('RESEARCH', `[PublisherGate] Drop arXiv "${(s.title||'').slice(0,50)}" — ${citations} citations < ${minCit}`);
            }
            return pass;
        }

        // OpenAlex / Semantic Scholar / MCP: publisher allow-list
        const publisherRaw = (s.publisher || s.journal || s.sourceProvider || '').toLowerCase();
        if (!publisherRaw || publisherRaw === 'openalex' || publisherRaw === 'semantic_scholar') {
            // No publisher metadata — keep in non-strict mode, drop in strict
            return !strict;
        }
        const matched = allowed.some(p => publisherRaw.includes(p));
        if (!matched && strict) {
            log.debug('RESEARCH', `[PublisherGate] Drop "${(s.title||'').slice(0,50)}" — publisher "${publisherRaw}" not in allow-list`);
        }
        return matched || !strict;
    });
}

/** Returns a Date 3 months in the past */
function threeMonthsAgo() {
    const d = new Date();
    d.setMonth(d.getMonth() - 3);
    return d;
}

function parseDate(value) {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

const academicSourceService = {
  /**
   * Unified academic retrieval — OpenAlex + Semantic Scholar + ArXiv in parallel.
   * Proportions are driven by the limit options passed by the orchestrator.
   *
   * @param {string} query
   * @param {object} options – { limit, openAlexLimit, semanticLimit, arxivLimit }
   */
  async retrieveSources(query, options = { limit: 10 }) {
    const limit         = options.limit        || 10;
    const openAlexLimit = options.openAlexLimit || Math.ceil(limit * 0.55);
    const semanticLimit = options.semanticLimit || Math.ceil(limit * 0.30);
    const arxivLimit    = options.arxivLimit    || Math.ceil(limit * 0.20);

    log.info('RESEARCH', `Academic retrieval: "${query.slice(0,50)}" (OA:${openAlexLimit} SS:${semanticLimit} Ax:${arxivLimit})`);

    // MCP enrichment: run OpenAlex + Semantic Scholar via the Python MCP server in parallel
    // with direct API calls. Results are deduped, so overlap is harmless.
    const [openAlexResult, semanticResult, arxivResult, mcpOaResult, mcpS2Result] = await Promise.allSettled([
      this.fetchOpenAlex(query, openAlexLimit),
      semanticScholarService.retrieveSources(query, { limit: semanticLimit }),
      this.fetchArxiv(query, arxivLimit),
      fetchViaMCP(query, { limit: Math.ceil(openAlexLimit * 0.5), source: 'openalex' }),
      fetchViaMCP(query, { limit: Math.ceil(semanticLimit * 0.5), source: 'semantic_scholar' }),
    ]);

    const openAlexSources = openAlexResult.status === 'fulfilled' ? openAlexResult.value : [];
    const semanticSources = semanticResult.status === 'fulfilled' ? semanticResult.value : [];
    const arxivSources    = arxivResult.status    === 'fulfilled' ? arxivResult.value    : [];
    const mcpOaSources    = mcpOaResult.status    === 'fulfilled' ? mcpOaResult.value    : [];
    const mcpS2Sources    = mcpS2Result.status    === 'fulfilled' ? mcpS2Result.value    : [];

    if (mcpOaSources.length > 0 || mcpS2Sources.length > 0) {
      log.info('RESEARCH', `[MCP] enriched with ${mcpOaSources.length + mcpS2Sources.length} additional open-access papers`);
    }

    const merged = this._mergeDedup([...openAlexSources, ...semanticSources, ...arxivSources, ...mcpOaSources, ...mcpS2Sources]);

    merged.sort((a, b) => {
      const citDiff = (b.citationCount || 0) - (a.citationCount || 0);
      return citDiff !== 0 ? citDiff : (b.year || 0) - (a.year || 0);
    });

    return merged.slice(0, limit);
  },

  /** Batch-fetch from OpenAlex across multiple queries (for orchestrator quota use). */
  async fetchOpenAlexBatch(queries = [], limitPerQuery = 8, constraints = {}) {
    const seen = new Set();
    const results = [];
    for (const q of queries) {
      const sources = await this.fetchOpenAlex(q, limitPerQuery, constraints);
      for (const s of sources) {
        const key = (s.doi || s.title || '').toLowerCase();
        if (key && !seen.has(key)) { seen.add(key); results.push(s); }
      }
    }
    return results;
  },

  /** Batch-fetch from Semantic Scholar across multiple queries. */
  async fetchSemanticBatch(queries = [], limitPerQuery = 6, constraints = {}) {
    return semanticScholarService.retrieveSourcesBulk(queries, limitPerQuery, constraints);
  },

  /** Batch-fetch from ArXiv across multiple queries. */
  async fetchArxivBatch(queries = [], limitPerQuery = 5, constraints = {}) {
    const seen = new Set();
    const results = [];
    for (const q of queries) {
      const sources = await this.fetchArxiv(q, limitPerQuery, constraints);
      for (const s of sources) {
        const key = (s.arxivId || s.title || '').toLowerCase();
        if (key && !seen.has(key)) { seen.add(key); results.push(s); }
      }
    }
    return results;
  },

  /**
   * Tag web sources: those older than 3 months receive goldStandard=true.
   * The orchestrator will flag them in the evidence profile.
   */
  tagWebSources(webSources = []) {
    const cutoff = threeMonthsAgo();
    return webSources.map(s => {
      const pubDate = parseDate(s.publishedDate || s.datePublished || s.year?.toString());
      const isOld   = pubDate !== null && pubDate < cutoff;
      return {
        ...s,
        goldStandard: isOld,
        goldStandardReason: isOld
          ? 'Authoritative source published > 3 months ago — included as historical reference'
          : null,
        recentWebSource: !isOld,
      };
    });
  },

  async fetchOpenAlex(query, limit, constraints = {}) {
    try {
      // Build OpenAlex filter string from structured constraints
      const filterParts = [];
      if (constraints.yearStart && constraints.yearEnd) {
        if (constraints.yearStart === constraints.yearEnd) {
          filterParts.push(`publication_year:${constraints.yearStart}`);
        } else {
          const years = [];
          for (let y = constraints.yearStart; y <= constraints.yearEnd; y++) years.push(y);
          filterParts.push(`publication_year:${years.join('|')}`);
        }
      } else if (constraints.yearStart) {
        filterParts.push(`publication_year:>${constraints.yearStart - 1}`);
      }

      // ── Trusted publisher filter ─────────────────────────────────────────
      // OpenAlex publisher IDs for the trusted allow-list.
      // When trustedPublishersOnly=true (always set for deep research) we push
      // an OR filter for IEEE | Elsevier | Springer | ScienceDirect.
      const TRUSTED_ORG_IDS = [
        'https://openalex.org/P4310315706',  // IEEE
        'https://openalex.org/P4310319900',  // Elsevier (includes ScienceDirect)
        'https://openalex.org/P4310319965',  // Springer / Springer Nature
        'https://openalex.org/P4310315823',  // Nature Portfolio
      ];
      if (constraints.trustedPublishersOnly) {
        // OpenAlex supports pipe (OR) for the same filter key
        filterParts.push(
          `primary_location.source.host_organization:${TRUSTED_ORG_IDS.join('|')}`
        );
        log.info('RESEARCH', '[PublisherGate] OpenAlex restricted to IEEE|Elsevier|Springer|Nature');
      } else if (constraints.venueFilter) {
        // Legacy single-venue filter kept for backward compatibility
        const VENUE_MAP = {
          'IEEE':     'https://openalex.org/P4310315706',
          'Elsevier': 'https://openalex.org/P4310319900',
          'Springer': 'https://openalex.org/P4310319965',
          'Nature':   'https://openalex.org/P4310315823',
        };
        const orgId = VENUE_MAP[constraints.venueFilter];
        if (orgId) {
          filterParts.push(`primary_location.source.host_organization:${orgId}`);
        } else {
          filterParts.push(`primary_location.source.display_name.search:${constraints.venueFilter}`);
        }
      }

      // Fetch extra headroom so post-fetch filtering doesn't under-deliver
      const fetchLimit = constraints.trustedPublishersOnly ? Math.min(limit * 2, 200) : Math.min(limit, 200);

      const params = {
        search:   query,
        per_page: fetchLimit,
        sort:     'cited_by_count:desc,publication_year:desc',
        select:   'id,title,abstract_inverted_index,authorships,publication_year,doi,cited_by_count,concepts,referenced_works,primary_location',
      };
      if (filterParts.length > 0) {
        params.filter = filterParts.join(',');
        log.info('RESEARCH', `OpenAlex filter: ${params.filter}`);
      }

      const response = await axios.get(OPENALEX_API, { params, timeout: 15000 });

      const works = response.data?.results || [];
      let mapped = works.map(work => {
        const journal    = work.primary_location?.source?.display_name || null;
        const publisher  = work.primary_location?.source?.host_organization_name || null;
        return {
          title:            work.title || 'Untitled',
          content:          this.reconstructOpenAlexAbstract(work.abstract_inverted_index),
          abstract:         this.reconstructOpenAlexAbstract(work.abstract_inverted_index),
          authors:          (work.authorships || []).map(a => a.author?.display_name).filter(Boolean),
          year:             work.publication_year || null,
          doi:              work.doi ? work.doi.replace('https://doi.org/', '') : null,
          url:              work.id || work.doi || null,
          journal,
          publisher,
          citationCount:    work.cited_by_count || 0,
          concepts:         (work.concepts || []).map(c => c.display_name),
          referenced_works: work.referenced_works || [],
          sourceType:       'academic',
          sourceProvider:   'openalex',
          credibilityBaseScore: 87,
        };
      });

      // Post-fetch gate: if trustedPublishersOnly is set, the API-level filter
      // already restricts results; this second pass catches anything that slipped
      // through (e.g. works without host_organization metadata).
      if (constraints.trustedPublishersOnly) {
        mapped = applyPublisherGate(mapped, false); // soft — missing publisher = keep
        log.info('RESEARCH', `[PublisherGate] OpenAlex: ${mapped.length}/${works.length} pass publisher check`);
      }

      return mapped.slice(0, limit);
    } catch (err) {
      log.warn('RESEARCH', `OpenAlex error: ${err.message}`);
      return [];
    }
  },

  async fetchArxiv(query, limit, constraints = {}) {
    try {
      const arxivQuery = query.trim().split(/\s+/).join('+AND+');
      // ArXiv date range filter: submittedDate:[YYYYMMDDHHNN+TO+YYYYMMDDHHNN]
      let searchQuery = `all:${arxivQuery}`;
      if (constraints.yearStart) {
        const start = `${constraints.yearStart}01010000`;
        const end   = `${constraints.yearEnd || constraints.yearStart}12312359`;
        searchQuery += `+AND+submittedDate:[${start}+TO+${end}]`;
      }

      const response = await axios.get(ARXIV_API, {
        params: {
          search_query: searchQuery,
          start:        0,
          max_results:  Math.min(limit, 100),
          sortBy:       'submittedDate',
          sortOrder:    'descending',
        },
        timeout: 10000,
      });

      const $ = cheerio.load(response.data, { xmlMode: true });
      let arxivEntries = $('entry').toArray().map(entry => {
        const el       = $(entry);
        const title    = el.find('title').text().trim().replace(/\s+/g, ' ');
        const abstract = el.find('summary').text().trim().replace(/\s+/g, ' ');
        const pubRaw   = el.find('published').text();
        const year     = pubRaw ? new Date(pubRaw).getFullYear() : null;
        const idUrl    = el.find('id').text();
        const arxivId  = idUrl.split('/abs/')[1] || idUrl;

        let doi = null;
        el.find('link[title="doi"]').each((_, link) => { doi = $(link).attr('href'); });
        if (doi) doi = doi.replace(/https?:\/\/(dx\.)?doi\.org\//, '');

        const authors = [];
        el.find('author name').each((_, name) => { authors.push($(name).text()); });

        return {
          title,
          content:          abstract,
          abstract,
          authors,
          year,
          doi,
          url:              idUrl,
          arxivId,
          publishedDate:    pubRaw ? new Date(pubRaw) : null,
          citationCount:    0,   // enriched below when trustedPublishersOnly
          concepts:         [],
          referenced_works: [],
          sourceType:       'academic',
          sourceProvider:   'arxiv',
          credibilityBaseScore: 80,
        };
      });

      // ── Citation gate for arXiv ─────────────────────────────────────────
      // When trustedPublishersOnly is active, enrich citation counts via
      // Semantic Scholar and drop papers below the minimum threshold.
      if (constraints.trustedPublishersOnly && arxivEntries.length > 0) {
        const minCit = TRUSTED_PUBLISHERS.arxivMinCitations;
        try {
          // Batch lookup by arXiv ID (max 10 at a time per S2 free tier)
          const ids = arxivEntries.slice(0, 20).map(e => `ARXIV:${(e.arxivId||'').split('v')[0]}`).filter(Boolean);
          if (ids.length > 0) {
            const s2Resp = await axios.post(
              'https://api.semanticscholar.org/graph/v1/paper/batch',
              { ids },
              { params: { fields: 'citationCount,externalIds' }, timeout: 8000 }
            ).catch(() => null);

            if (s2Resp?.data) {
              const citMap = {};
              for (const p of s2Resp.data) {
                const aid = p?.externalIds?.ArXiv;
                if (aid && p.citationCount != null) citMap[aid] = p.citationCount;
              }
              arxivEntries = arxivEntries.map(e => {
                const baseId = (e.arxivId||'').split('v')[0];
                if (citMap[baseId] != null) return { ...e, citationCount: citMap[baseId] };
                return e;
              });
            }
          }
        } catch (_) { /* S2 enrichment best-effort */ }

        const before = arxivEntries.length;
        // Papers published in the last 12 months are exempt (not yet cited)
        const cutoffYear = new Date().getFullYear() - 1;
        arxivEntries = arxivEntries.filter(e => {
          if ((e.year || 0) >= cutoffYear) return true;  // too new to have citations
          return (e.citationCount || 0) >= minCit;
        });
        log.info('RESEARCH', `[PublisherGate] arXiv: ${arxivEntries.length}/${before} pass citation gate (≥${minCit} or published ≥${cutoffYear})`);
      }

      return arxivEntries.slice(0, limit);
    } catch (err) {
      log.warn('RESEARCH', `ArXiv error: ${err.message}`);
      return [];
    }
  },

  reconstructOpenAlexAbstract(invertedIndex) {
    if (!invertedIndex) return 'No abstract available.';
    const wordList = [];
    let maxLen = 0;
    for (const [word, positions] of Object.entries(invertedIndex)) {
      for (const pos of positions) {
        wordList[pos] = word;
        if (pos > maxLen) maxLen = pos;
      }
    }
    return Array.from({ length: maxLen + 1 }, (_, i) => wordList[i] || '').join(' ').trim();
  },

  /** Deduplicate merged sources by DOI or normalised title. */
  _mergeDedup(sources = []) {
    const map = new Map();
    for (const s of sources) {
      const doiKey   = s.doi   ? `doi:${s.doi.toLowerCase()}`                    : null;
      const titleKey = s.title ? `title:${s.title.toLowerCase().slice(0, 80)}`   : null;
      const key      = doiKey || titleKey;
      if (!key) { map.set(Math.random().toString(), s); continue; }
      if (!map.has(key)) {
        map.set(key, s);
      } else {
        const existing = map.get(key);
        const newLen   = (s.abstract || s.content || '').length;
        const oldLen   = (existing.abstract || existing.content || '').length;
        if (newLen > oldLen) map.set(key, { ...existing, ...s });
      }
    }
    return Array.from(map.values());
  },

  /**
   * Directly call the MCP paper-search server.
   * Useful for on-demand single-source lookups without the full pipeline.
   *
   * @param {string} query
   * @param {object} opts  { limit, source: 'arxiv'|'openalex'|'semantic_scholar' }
   */
  async fetchViaMCP(query, opts = {}) {
    return fetchViaMCP(query, opts);
  },

  /**
   * Resolve a DOI to full metadata via the MCP server's OpenAlex bridge.
   * @param {string} doi
   */
  async resolveDoi(doi) {
    try {
      return await _callMcpTool('get_paper_by_doi', { doi }, 15000);
    } catch (err) {
      log.warn('RESEARCH', `[MCP] resolveDoi(${doi}) failed: ${err.message}`);
      return null;
    }
  },
};

module.exports = academicSourceService;
