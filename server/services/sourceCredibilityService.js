/**
 * Source Credibility Service
 * 
 * Formal credibility scoring engine based on exact heuristics:
 * Score = 0.30*Authority + 0.25*Citations + 0.20*Recency + 0.15*Agreement + 0.10*Completeness
 */

const sourceCredibilityService = {
    /**
     * Evaluate the credibility of a given source using formal research metrics.
     * @param {Object} source - The AcademicSource or WebSource
     * @param {Array} allSources - Context of all sources for CrossSourceAgreement mapping (optional)
     * @returns {Object} { score: number, reasoning: string[], signals: Object }
     */
    evaluateSourceCredibility(source, allSources = []) {
        let reasons = [];
        let signals = {};

        // 1. Source Authority (30%)
        let authorityScore = 0;
        if (source.sourceType === 'local') {
            authorityScore = 100; // Local Knowledge Base is fully trusted
            reasons.push('Local KB provides absolute authority (100/100).');
        } else if (source.sourceType === 'academic') {
            if (source.url?.includes('arxiv') || source.arxivId) {
                authorityScore = 85; 
                reasons.push('arXiv pre-print indicates high authority (85/100).');
            } else if (source.url?.includes('doi') || source.doi) {
                authorityScore = 95; // Peer reviewed default presumption if it has a DOI in OA
                reasons.push('DOI present, indicating peer-reviewed authority (95/100).');
            } else {
                authorityScore = 80;
                reasons.push('Academic source without explicit DOI/ArXiv identifier (80/100).');
            }
        } else {
            // Web Sources
            if (source.url?.includes('.gov') || source.url?.includes('.edu')) {
                authorityScore = 90;
                reasons.push('Government/Educational domain (90/100).');
            } else if (source.url?.match(/\.(org|io)$/)) {
                authorityScore = 60;
                reasons.push('Standard organizational domain (60/100).');
            } else {
                authorityScore = 40;
                reasons.push('General web domain (40/100).');
            }
        }
        signals.authority = authorityScore;

        // 2. Citation Count Score (25%)
        let citationScore = 0;
        if (source.sourceType === 'local') {
            citationScore = 100; // Trusted by default
            reasons.push('Local source bypasses citation requirement (100/100).');
        } else {
            const citations = source.citationCount || 0;
            if (citations > 1000) citationScore = 100;
            else if (citations > 200) citationScore = 85;
            else if (citations > 50) citationScore = 70;
            else if (citations > 10) citationScore = 50;
            else if (citations > 0) citationScore = 30;
            else citationScore = 10;
            
            reasons.push(`Citation count (${citations}) yields score of ${citationScore}/100.`);
        }
        signals.citations = citationScore;


        // 3. Recency Score (20%)
        let recencyScore = 50; 
        const currentYear = new Date().getFullYear();
        const pubYear = source.year ? parseInt(source.year) : (source.publishedDate ? new Date(source.publishedDate).getFullYear() : currentYear - 10);
        
        const age = currentYear - pubYear;
        if (age <= 1) recencyScore = 100;
        else if (age <= 3) recencyScore = 90;
        else if (age <= 5) recencyScore = 75;
        else if (age <= 10) recencyScore = 50;
        else recencyScore = 30;

        reasons.push(`Publication age (${age} years) yields recency score of ${recencyScore}/100.`);
        signals.recency = recencyScore;


        // 4. Cross Source Agreement (15%) - Mocked initially unless CitationGraph is passed
        // For now, baseline is 60. Later factCheckingService adjusts this.
        let agreementScore = 60; 
        if (source.sourceType === 'local') agreementScore = 100;
        reasons.push('Baseline cross-source agreement score applied.');
        signals.agreement = agreementScore;


        // 5. Metadata Completeness (10%)
        let completenessScore = 0;
        let metadataFields = ['title', 'authors', 'year', 'doi', 'abstract', 'url'];
        let matched = 0;
        metadataFields.forEach(f => {
            if (source[f] && (Array.isArray(source[f]) ? source[f].length > 0 : true)) matched++;
        });
        
        completenessScore = Math.round((matched / metadataFields.length) * 100);
        reasons.push(`Metadata completeness is ${matched}/${metadataFields.length} (${completenessScore}/100).`);
        signals.completeness = completenessScore;


        // Final Calculation
        const finalScore = (
            (0.30 * authorityScore) +
            (0.25 * citationScore) +
            (0.20 * recencyScore) +
            (0.15 * agreementScore) +
            (0.10 * completenessScore)
        );

        let roundedScore = Math.max(0, Math.min(100, Math.round(finalScore)));

        return {
            credibilityScore: roundedScore,
            reason: reasons.join(' '), // For legacy compatibility with string expectations
            reasoning: reasons,
            signals: signals
        };
    }
};

module.exports = sourceCredibilityService;
