const log = require('../utils/logger');
/**
 * Web Crawler Service (Deep Research Component)
 * 
 * Fetches, parses, and cleans content from web URLs.
 * Works in tandem with the Web Search Service (which provides the URLs) 
 * to deepen the research capabilities beyond snippets.
 */

const axios = require('axios');
const cheerio = require('cheerio');
const { performWebSearch } = require('./webSearchService');

// Simple blacklist to avoid known low-quality domains
const BLACKLIST_DOMAINS = [
    'youtube.com', 'facebook.com', 'twitter.com', 'instagram.com',
    'tiktok.com', 'pinterest.com', 'reddit.com/r/all'
];

async function crawlUrl(url) {
    try {
        // log.info('RESEARCH', `Fetching: ${url}`);

        const response = await axios.get(url, {
            timeout: 5000, // 5s timeout to prevent hanging
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; iMentorBot/1.0; +http://imentor.ai)'
            }
        });

        if (response.status !== 200) {
            log.warn('RESEARCH', `Fetch failed for ${url}`);
            return null;
        }

        const $ = cheerio.load(response.data);

        // Remove unwanted elements
        $('script, style, nav, footer, header, aside, .ad, .advertisement, [role="banner"], [role="navigation"]').remove();

        // Extract main content - prioritize common content containers
        let content = $('main, article, .content, .post-content, #content, body').first().text();

        // Clean whitespace
        content = content.replace(/\s+/g, ' ').trim();

        // Basic validation
        if (content.length < 200) {
            log.warn('RESEARCH', `Content too short for ${url}`);
            return null;
        }

        // Truncate safely
        return content.substring(0, 3000);

    } catch (error) {
        // log.warn('RESEARCH', `Error crawling ${url}`);
        return null;
    }
}

const webCrawlerService = {

    /**
     * Search the web and then crawl top results for full content.
     * @param {string} query - Search query.
     * @param {number} limit - Max number of results to crawl.
     * @returns {Promise<Array>} List of crawled web sources.
     */
    async searchAndCrawl(query, limit = 5) {
        try {
            log.info('RESEARCH', `Crawling web for: "${query.substring(0, 40)}..."`);

            // 1. Get URLs from Search Service
            // Note: performWebSearch returns { toolOutput, references: [{title, url, snippet}] }
            // We need to parse or use the references directly if available.
            // Assuming performWebSearch structure fits here or we adapt.
            // If performWebSearch output is just text, we might need a structured search function.
            // For now, let's assume performWebSearch can return structured results or we use a direct search API here if needed.
            // BETTER: Reuse existing service but parse its output if it's text-heavy, OR just use the 'references' array if it exists.

            const searchResult = await performWebSearch(query);

            let urlsToCrawl = [];

            if (searchResult.references && Array.isArray(searchResult.references)) {
                urlsToCrawl = searchResult.references
                    .filter(ref => !BLACKLIST_DOMAINS.some(domain => ref.url.includes(domain)))
                    .slice(0, limit);
            } else {
                // Fallback reasoning if no structured refs (depends on implementation of performWebSearch)
                log.warn('RESEARCH', "No structured search results to crawl.");
                return [];
            }

            // log.info('RESEARCH', `Found ${urlsToCrawl.length} URLs to crawl.`);

            // 2. Parallel Crawl
            const crawlPromises = urlsToCrawl.map(async (ref) => {
                const content = await crawlUrl(ref.url);
                if (!content) return null;

                return {
                    title: ref.source || ref.title || 'Untitled Source',
                    content: content,
                    url: ref.url,
                    sourceType: 'web',
                    publishedDate: new Date()
                };
            });

            const results = await Promise.all(crawlPromises);
            const validResults = results.filter(r => r !== null);
            log.success('RESEARCH', `Successfully crawled ${validResults.length} pages.`);

            return validResults;

        } catch (error) {
            log.error('RESEARCH', "Search and crawl failed", error);
            return []; // Fail gracefully
        }
    }
};

module.exports = webCrawlerService;
