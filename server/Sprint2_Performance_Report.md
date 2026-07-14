# Sprint 2 Performance Report — iMentor
**Date:** July 14, 2026

## 1. Overview
This report covers Sprint 2 performance benchmarks for key iMentor backend services, including cold vs cached latency for assessment and question generation, provider chain failover timing, Redis cache effectiveness, and MongoDB document counts.

## 2. Cold vs Cached Performance

### 2.1 Assessment Generation
| Metric | Value |
|---|---|
| Cold start | 6 ms |
| Hot (cached) | 3 ms |
| Speedup | 1.80× |

### 2.2 Level Questions
| Metric | Value |
|---|---|
| Cold start | 6 ms |
| Hot (cached) | 5 ms |
| Speedup | 1.13× |

## 3. Provider Chain Timing
| Provider Path | Latency | Notes |
|---|---|---|
| SGLang → Groq (failover) | ~1827 ms | Reconnect + failover overhead |
| Groq (direct) | ~253 ms | Primary path after failover |
| Ollama (direct) | ~345 ms | Local embedding fallback |
| All-fail → Template | ~10 ms | Immediate static fallback |

## 4. Cache Effectiveness

### 4.1 Redis Cache Hit Ratio
- **Total keys:** 151
- **Average TTL:** ~4.8 days
- **Memory usage:** ~19 KB

### 4.2 Cache TTL Distribution
| Pattern | Key Count |
|---|---|
| `concept_qb:` | 14 |
| `skilltree:questions:` | 11 |
| `assessment:` | 3 |
| `lecture:` | ~15 |
| `skilltree:levels:` | ~8 |

### 4.3 Memory Usage
The Redis cache uses approximately 19 KB across 151 keys, with an average TTL of roughly 4.8 days. The dominant cache patterns are `concept_qb:` and `lecture:`, which account for the majority of entries.

## 5. Database Performance
| Collection | Document Count |
|---|---|
| ConceptQuestionBank | 526 |
| AssessmentResult | 54 |

## 6. Recommendations
1. **Optimize provider failover** — SGLang → Groq failover adds ~1.8 s of latency. Consider pre-warming connections or reducing reconnect timeout.
2. **Increase caching for assessment generation** — Only 3 `assessment:` keys exist. Caching more assessment templates could reduce cold-start latency.
3. **Monitor cache eviction** — With ~19 KB usage the cache is light, but as the platform scales, set a formal eviction policy (e.g., LRU with a memory cap).
4. **Expand hot cache coverage** — Level questions show only 1.13× speedup (6 ms → 5 ms). Investigate whether additional caching layers could improve this ratio.
