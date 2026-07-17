const log = require('../utils/logger');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const pdfExportService = {
    /**
     * Generate a professional academic PDF using Puppeteer
     * @param {Object} report - The research report object from DB
     * @returns {Promise<Buffer>} The PDF buffer
     */
    async generateAcademicPDF(report) {
        const researchData = report.researchReport || {};
        const sourcesRaw = researchData.sourcesUsed || report.sourcesUsed || report.sources || [];
        const sources = Array.isArray(sourcesRaw) ? sourcesRaw : [];

        const htmlContent = this.buildHTMLTemplate(report, researchData, sources);

        let browser;
        try {
            // Find a local browser if bundled one is missing (resilience for Windows)
            const possiblePaths = [
                'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
                'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
            ];

            let executablePath = null;
            for (const p of possiblePaths) {
                if (fs.existsSync(p)) {
                    executablePath = p;
                    log.info('SYSTEM', `Using browser: ${p}`);
                    break;
                }
            }

            const launchOptions = {
                headless: "new",
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            };

            if (executablePath) {
                launchOptions.executablePath = executablePath;
            }

            browser = await puppeteer.launch(launchOptions);

            const page = await browser.newPage();
            log.info('SYSTEM', `Generating PDF for "${report.researchReport?.title?.substring(0, 30)}..."`);
            await page.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 60000 });

            const pdfBuffer = await page.pdf({
                format: 'A4',
                printBackground: true,
                margin: {
                    top: '25mm',
                    bottom: '25mm',
                    left: '22mm',
                    right: '22mm'
                },
                displayHeaderFooter: true,
                footerTemplate: `
          <div style="font-size: 8px; color: #999; width: 100%; text-align: center; font-family: 'Georgia', serif; padding: 0 22mm;">
            <span style="float: left;">iMentor Deep Research Engine</span>
            <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
          </div>
        `,
                headerTemplate: '<div></div>',
            });

            log.success('SYSTEM', "PDF generated successfully");
            return pdfBuffer;
        } catch (error) {
            log.error('SYSTEM', `PDF generation failed: ${error.message}`);
            throw error;
        } finally {
            if (browser) await browser.close();
        }
    },

    buildHTMLTemplate(report, data, sources) {
        const confidence = data.overallConfidenceScore || report.overallConfidenceScore || 0;
        const summary = data.executiveSummary || {};
        const crossAnalysis = data.crossSourceAnalysis || {};
        const risks = data.riskAssessment || {};
        const confCalc = data.confidenceCalculation || {};
        const takeaways = data.studentTakeaways || {};

        // Use the generated academic title, falling back to query
        const reportTitle = data.title || report.researchReport?.title || report.query || 'Untitled Research';

        // Consensus index
        const consensusIndex = data.consensusIndex || confCalc.consensusIndex || summary.consensusIndex || null;
        const consensusCategory = data.consensusCategory || confCalc.consensusCategory || '';

        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        /* System fonts only — no external requests to avoid PDF timeout */
        
        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: 'Crimson Text', 'Georgia', serif;
            font-size: 14px;
            line-height: 1.78;
            color: #1a1a1a;
            background: #fff;
        }

        .container {
            max-width: 720px;
            margin: 0 auto;
            padding: 0;
        }

        /* ================================
           SANS-SERIF UTILITY (for labels)
           ================================ */
        .sans {
            font-family: 'Inter', 'Helvetica Neue', Arial, sans-serif;
        }

        /* ================================
           COVER PAGE
           ================================ */
        .cover-page {
            min-height: 860px;
            display: flex;
            flex-direction: column;
            justify-content: center;
            text-align: center;
            border-bottom: 3px solid #000;
            page-break-after: always;
            padding: 60px 20px;
        }

        .cover-institution {
            font-family: 'Inter', sans-serif;
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 5px;
            color: #999;
            margin-bottom: 70px;
        }

        .cover-title {
            font-size: 36px;
            font-weight: 700;
            line-height: 1.22;
            margin-bottom: 18px;
            color: #000;
            max-width: 620px;
            margin-left: auto;
            margin-right: auto;
        }

        .cover-subtitle {
            font-size: 15px;
            color: #777;
            font-weight: 400;
            font-style: italic;
            margin-bottom: 10px;
        }

        .cover-query {
            font-size: 12px;
            color: #aaa;
            font-family: 'Inter', sans-serif;
            margin-bottom: 60px;
            letter-spacing: 0.3px;
        }

        .cover-meta-grid {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr;
            gap: 30px;
            max-width: 520px;
            margin: 40px auto 0;
            text-align: center;
        }

        .cover-meta-item {
            font-family: 'Inter', sans-serif;
        }

        .cover-meta-label {
            font-size: 8px;
            text-transform: uppercase;
            letter-spacing: 2.5px;
            color: #aaa;
            display: block;
            margin-bottom: 5px;
            font-weight: 600;
        }

        .cover-meta-value {
            font-size: 13px;
            color: #333;
            font-weight: 600;
        }

        .cover-badges {
            margin-top: 45px;
            display: flex;
            justify-content: center;
            gap: 20px;
        }

        .confidence-badge {
            display: inline-block;
            padding: 10px 24px;
            border: 2px solid #000;
            font-family: 'Inter', sans-serif;
            font-size: 10px;
            font-weight: 700;
            letter-spacing: 1px;
            text-transform: uppercase;
        }

        .consensus-badge {
            display: inline-block;
            padding: 10px 24px;
            border: 1px solid #ccc;
            font-family: 'Inter', sans-serif;
            font-size: 10px;
            font-weight: 600;
            letter-spacing: 0.5px;
            color: #555;
        }

        /* ================================
           SECTION STYLING
           ================================ */
        .section {
            margin-bottom: 50px;
            page-break-inside: avoid;
        }

        .section-header {
            display: flex;
            align-items: baseline;
            gap: 18px;
            border-bottom: 2px solid #ddd;
            margin-bottom: 24px;
            padding-bottom: 14px;
            margin-top: 55px;
        }

        .section-header:first-child {
            margin-top: 0;
        }

        .section-number {
            font-family: 'Inter', sans-serif;
            font-size: 36px;
            font-weight: 700;
            color: #e0e0e0;
            line-height: 1;
            min-width: 50px;
        }

        .section-title {
            font-size: 23px;
            font-weight: 700;
            margin: 0;
            flex: 1;
            color: #000;
            letter-spacing: -0.3px;
        }

        .evidence-badge {
            font-family: 'Inter', sans-serif;
            font-size: 8px;
            background: #f4f4f4;
            color: #666;
            padding: 3px 10px;
            text-transform: uppercase;
            font-weight: 700;
            letter-spacing: 0.8px;
            white-space: nowrap;
            border: 1px solid #e0e0e0;
        }

        .body-text {
            font-size: 14.5px;
            text-align: justify;
            color: #2a2a2a;
            line-height: 1.82;
            hyphens: auto;
        }

        .body-text p {
            margin-bottom: 14px;
            text-indent: 0;
        }

        .cross-comparison {
            margin-top: 18px;
            padding: 14px 18px;
            border-left: 3px solid #ccc;
            background: #fafafa;
            font-style: italic;
            font-size: 13px;
            color: #555;
            line-height: 1.7;
        }

        .quant-box {
            margin-top: 20px;
            background: #fafafa;
            padding: 16px 20px;
            border: 1px solid #eee;
        }

        .quant-box ul {
            margin: 8px 0 0 0;
        }

        /* ================================
           EXECUTIVE SUMMARY
           ================================ */
        .summary-box {
            background: #f8f8f8;
            padding: 32px 38px;
            border-left: 5px solid #000;
            margin-bottom: 50px;
        }

        .summary-overview {
            font-size: 16.5px;
            font-style: italic;
            line-height: 1.72;
            color: #333;
            margin-bottom: 26px;
        }

        .summary-detail {
            margin-bottom: 18px;
        }

        .summary-detail-label {
            font-family: 'Inter', sans-serif;
            font-size: 8px;
            text-transform: uppercase;
            letter-spacing: 2px;
            color: #999;
            font-weight: 700;
            display: block;
            margin-bottom: 6px;
        }

        .summary-detail-text {
            font-size: 13.5px;
            color: #444;
            line-height: 1.65;
        }

        .consensus-indicator {
            font-family: 'Inter', sans-serif;
            display: inline-block;
            margin-top: 16px;
            padding: 6px 14px;
            background: #f0f0f0;
            border: 1px solid #ddd;
            font-size: 10px;
            font-weight: 700;
            letter-spacing: 0.5px;
            color: #555;
        }

        /* ================================
           CROSS-SOURCE ANALYSIS
           ================================ */
        .analysis-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 32px;
            margin-top: 22px;
        }

        .analysis-column h4 {
            font-family: 'Inter', sans-serif;
            font-size: 9px;
            text-transform: uppercase;
            letter-spacing: 2px;
            color: #888;
            font-weight: 700;
            margin-bottom: 14px;
            padding-bottom: 8px;
            border-bottom: 1px solid #eee;
        }

        .analysis-column ul {
            padding-left: 16px;
        }

        .analysis-column li {
            margin-bottom: 10px;
            font-size: 13px;
            line-height: 1.55;
            color: #444;
        }

        /* ================================
           CONFIDENCE BREAKDOWN
           ================================ */
        .confidence-breakdown {
            background: #fafafa;
            border: 1px solid #eee;
            padding: 28px 32px;
            margin-top: 35px;
        }

        .confidence-breakdown h3 {
            font-family: 'Inter', sans-serif;
            font-size: 9px;
            text-transform: uppercase;
            letter-spacing: 2px;
            color: #999;
            font-weight: 700;
            margin-bottom: 16px;
        }

        .confidence-metrics {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr 1fr;
            gap: 16px;
            margin-bottom: 14px;
        }

        .conf-metric {
            font-family: 'Inter', sans-serif;
            text-align: center;
        }

        .conf-metric-value {
            font-size: 22px;
            font-weight: 700;
            color: #000;
        }

        .conf-metric-label {
            font-size: 8px;
            text-transform: uppercase;
            letter-spacing: 1px;
            color: #aaa;
            margin-top: 4px;
        }

        .conf-explanation {
            font-size: 12px;
            color: #666;
            font-style: italic;
            text-align: center;
            margin-top: 14px;
            padding-top: 14px;
            border-top: 1px solid #eee;
            line-height: 1.6;
        }

        /* ================================
           OUTLOOK SECTION
           ================================ */
        .outlook-section {
            background: #111;
            color: #ccc;
            padding: 44px;
            margin-top: 35px;
            page-break-inside: avoid;
        }

        .outlook-section h2 {
            color: #fff;
            margin-top: 0;
            margin-bottom: 18px;
            font-size: 22px;
        }

        .outlook-section .body-text {
            color: #bbb;
        }

        /* ================================
           REFERENCES (Academic Style)
           ================================ */
        .references-section {
            page-break-before: always;
            padding-top: 20px;
        }

        .references-header {
            font-size: 24px;
            margin-bottom: 32px;
            padding-bottom: 12px;
            border-bottom: 2px solid #ddd;
            font-family: 'Crimson Text', Georgia, serif;
        }

        .reference-item {
            margin-bottom: 18px;
            font-size: 12px;
            line-height: 1.65;
            padding-left: 34px;
            text-indent: -34px;
            color: #333;
        }

        .ref-number {
            font-family: 'Inter', sans-serif;
            font-weight: 700;
            color: #000;
            font-size: 11px;
        }

        .ref-authors {
            font-weight: 600;
        }

        .ref-year {
            font-weight: 400;
        }

        .ref-title {
            font-style: italic;
        }

        .ref-publisher {
            color: #555;
        }

        .ref-doi {
            font-family: 'Inter', sans-serif;
            font-size: 10px;
            color: #666;
            word-break: break-all;
        }

        .ref-url {
            font-family: 'Inter', sans-serif;
            font-size: 10px;
            color: #666;
            text-decoration: none;
            word-break: break-all;
            display: block;
            margin-top: 2px;
        }

        /* ================================
           LISTS
           ================================ */
        ul { padding-left: 20px; }
        li { margin-bottom: 8px; font-size: 13.5px; }

        /* ================================
           CITATIONS (Superscript)
           ================================ */
        sup {
            color: #000;
            font-family: 'Inter', sans-serif;
            font-weight: 700;
            font-size: 9px;
            vertical-align: super;
        }

        /* ================================
           DIVIDERS
           ================================ */
        .section-divider {
            text-align: center;
            margin: 48px 0;
            color: #ccc;
            font-size: 14px;
            letter-spacing: 8px;
        }

        .thin-rule {
            border: none;
            border-top: 1px solid #e8e8e8;
            margin: 35px 0;
        }
    </style>
</head>
<body>
    <div class="container">
        
        <!-- ======================== COVER PAGE ======================== -->
        <div class="cover-page">
            <div class="cover-institution">iMentor Deep Research Engine</div>
            <h1 class="cover-title">${this.escapeHtml(reportTitle)}</h1>
            <h2 class="cover-subtitle">Comprehensive Analytical Research Report</h2>
            ${reportTitle !== report.query ? `<div class="cover-query">Research Query: "${this.escapeHtml(report.query)}"</div>` : '<div style="margin-bottom: 60px;"></div>'}
            
            <div class="cover-meta-grid">
                <div class="cover-meta-item">
                    <span class="cover-meta-label">Published</span>
                    <span class="cover-meta-value">${new Date(report.createdAt || Date.now()).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</span>
                </div>
                <div class="cover-meta-item">
                    <span class="cover-meta-label">Sources</span>
                    <span class="cover-meta-value">${sources.length} Analyzed</span>
                </div>
                <div class="cover-meta-item">
                    <span class="cover-meta-label">Methodology</span>
                    <span class="cover-meta-value">${report.mode === 'HYBRID' ? 'Hybrid' : 'Online'} Analysis</span>
                </div>
            </div>

            <div class="cover-badges">
                <div class="confidence-badge">
                    Analytical Confidence: ${confidence}%
                </div>
                ${consensusIndex !== null ? `
                <div class="consensus-badge">
                    Consensus Index: ${consensusIndex} — ${this.escapeHtml(consensusCategory)}
                </div>
                ` : ''}
            </div>
        </div>

        <!-- ======================== EXECUTIVE SUMMARY ======================== -->
        <div class="section">
            <div class="section-header" style="margin-top: 0;">
                <span class="section-number">I</span>
                <h2 class="section-title">Executive Summary</h2>
            </div>
            <div class="summary-box">
                <div class="summary-overview">
                    ${this.formatCitations(this.escapeHtml(summary.analyticalOverview || 'Analysis pending.'))}
                </div>
                
                <div class="summary-detail">
                    <span class="summary-detail-label">Source Agreement</span>
                    <span class="summary-detail-text">${this.formatCitations(this.escapeHtml(summary.sourceAgreement || 'Evidence integration complete.'))}</span>
                </div>

                ${summary.primaryContradiction ? `
                <div class="summary-detail">
                    <span class="summary-detail-label">Primary Contradiction</span>
                    <span class="summary-detail-text">${this.formatCitations(this.escapeHtml(summary.primaryContradiction))}</span>
                </div>
                ` : ''}

                ${summary.strongestInsight ? `
                <div class="summary-detail">
                    <span class="summary-detail-label">Decisive Analytical Conclusion</span>
                    <span class="summary-detail-text" style="font-style: italic; font-weight: 600; color: #333;">${this.formatCitations(this.escapeHtml(summary.strongestInsight))}</span>
                </div>
                ` : ''}

                ${consensusIndex !== null ? `
                <div class="consensus-indicator">
                    Consensus Strength Index: ${consensusIndex} (${this.escapeHtml(consensusCategory)})
                </div>
                ` : ''}
            </div>
        </div>

        <div class="section-divider">• • •</div>

        <!-- ======================== MAIN ANALYSIS SECTIONS ======================== -->
        ${(Array.isArray(data.sections) ? data.sections : []).map((section, idx) => `
            <div class="section">
                <div class="section-header">
                    <span class="section-number">${this.toRoman(idx + 2)}</span>
                    <h2 class="section-title">${this.escapeHtml(section.title)}</h2>
                    ${section.evidenceStrength ? `<span class="evidence-badge">${this.escapeHtml(typeof section.evidenceStrength === 'string' ? section.evidenceStrength.split('|')[0].trim().split('(')[0].trim() : section.evidenceStrength)}</span>` : ''}
                </div>
                <div class="body-text">
                    ${this.formatParagraphs(this.escapeHtml(section.content))}
                </div>
                
                ${section.crossSourceComparison ? `
                    <div class="cross-comparison">
                        ${this.formatCitations(this.escapeHtml(section.crossSourceComparison))}
                    </div>
                ` : ''}
                
                ${Array.isArray(section.quantitativeSignals) && section.quantitativeSignals.length > 0 ? `
                    <div class="quant-box">
                        <span class="summary-detail-label">Quantitative Signals</span>
                        <ul style="margin: 8px 0 0 0;">
                            ${section.quantitativeSignals.map(s => `<li>${this.formatCitations(this.escapeHtml(s))}</li>`).join('')}
                        </ul>
                    </div>
                ` : ''}
            </div>
        `).join('\n<div class="section-divider">• • •</div>\n')}

        <!-- ======================== CROSS-SOURCE ANALYSIS ======================== -->
        <div class="section">
            <div class="section-header">
                <span class="section-number">${this.toRoman((data.sections?.length || 0) + 2)}</span>
                <h2 class="section-title">Cross-Source Analysis</h2>
            </div>
            <div class="analysis-grid">
                <div class="analysis-column">
                    <h4>Areas of Consensus</h4>
                    <ul>${(Array.isArray(crossAnalysis.consensusAreas) ? crossAnalysis.consensusAreas : []).map(a => `<li>${this.formatCitations(this.escapeHtml(a))}</li>`).join('')}</ul>
                </div>
                <div class="analysis-column">
                    <h4>Points of Disagreement</h4>
                    <ul>${(Array.isArray(crossAnalysis.disagreementAreas) ? crossAnalysis.disagreementAreas : []).map(a => `<li>${this.formatCitations(this.escapeHtml(a))}</li>`).join('')}</ul>
                </div>
            </div>
            ${Array.isArray(crossAnalysis.researchGaps) && crossAnalysis.researchGaps.length > 0 ? `
                <hr class="thin-rule" />
                <div class="analysis-column">
                    <h4>Research Gaps Identified</h4>
                    <ul>${crossAnalysis.researchGaps.map(g => `<li>${this.escapeHtml(g)}</li>`).join('')}</ul>
                </div>
            ` : ''}
        </div>

        <!-- ======================== CONFIDENCE BREAKDOWN ======================== -->
        <div class="confidence-breakdown">
            <h3>Analytical Confidence Breakdown</h3>
            <div class="confidence-metrics">
                <div class="conf-metric">
                    <div class="conf-metric-value">${confidence}%</div>
                    <div class="conf-metric-label">Overall</div>
                </div>
                <div class="conf-metric">
                    <div class="conf-metric-value">${confCalc.avgSourceCredibility || Math.round(sources.reduce((a, s) => a + (s.credibilityScore || 0), 0) / Math.max(sources.length, 1))}</div>
                    <div class="conf-metric-label">Avg. Source Quality</div>
                </div>
                <div class="conf-metric">
                    <div class="conf-metric-value">${sources.length}</div>
                    <div class="conf-metric-label">Sources</div>
                </div>
                <div class="conf-metric">
                    <div class="conf-metric-value">${consensusIndex !== null ? consensusIndex : '—'}</div>
                    <div class="conf-metric-label">Consensus Index</div>
                </div>
            </div>
            <div class="conf-explanation">
                ${this.escapeHtml(confCalc.explanation || 'Reliability score based on multi-source validation and domain credibility.')}
            </div>
        </div>

        <!-- ======================== FUTURE OUTLOOK ======================== -->
        <div class="outlook-section">
            <h2 style="font-family: 'Crimson Text', Georgia, serif;">Future Outlook &amp; Limitations</h2>
            ${risks.limitations ? `
                <div style="margin-bottom: 22px;">
                    <span class="summary-detail-label" style="color: #777;">Methodological Limitations</span>
                    <div class="body-text">${this.formatCitations(this.escapeHtml(risks.limitations))}</div>
                </div>
            ` : ''}
            <div class="body-text">
                ${this.formatCitations(this.escapeHtml(risks.futureOutlook || 'Ongoing field evolution expected.'))}
            </div>
        </div>

        <!-- ======================== REFERENCES (Academic Format) ======================== -->
        <div class="references-section">
            <h2 class="references-header">References</h2>
            <div style="margin-top: 20px;">
                ${sources.map((s, i) => {
            const citNum = s.citationIndex || s.id || (i + 1);
            const authors = this.formatAuthorsForReference(s.authors);
            const year = s.year || s.publishedYear || null;
            const title = s.title || 'Untitled';
            const publisher = s.publisher || s.type || s.sourceType || '';
            const doi = s.doi || null;
            const url = s.url || null;

            return `
                        <div class="reference-item">
                            <span class="ref-number">[${citNum}]</span>
                            <span class="ref-authors">${this.escapeHtml(authors)}</span>
                            ${year ? `<span class="ref-year"> (${year}).</span>` : '.'}
                            <span class="ref-title"> ${this.escapeHtml(title)}.</span>
                            ${publisher ? `<span class="ref-publisher"> ${this.escapeHtml(publisher)}.</span>` : ''}
                            ${doi ? `<div class="ref-doi">DOI: ${this.escapeHtml(doi)}</div>` : ''}
                            ${url ? `<a href="${url}" class="ref-url">${url}</a>` : ''}
                        </div>
                    `;
        }).join('')}
            </div>
        </div>

    </div>
</body>
</html>
    `;
    },

    /**
     * Format author array into academic reference style.
     * "LastName, F.I., LastName, F.I."  
     * If > 3 authors: "First Author et al."
     */
    formatAuthorsForReference(authors) {
        if (!authors || authors.length === 0) return 'Unknown';

        if (authors.length > 3) {
            return `${authors[0]} et al.`;
        }

        return authors.map(author => {
            if (!author) return 'Unknown';
            const parts = author.trim().split(/\s+/);
            if (parts.length >= 2) {
                const lastName = parts[parts.length - 1];
                const initials = parts.slice(0, -1).map(n => n[0]?.toUpperCase() + '.').join(' ');
                return `${lastName}, ${initials}`;
            }
            return author;
        }).join(', ');
    },

    /**
     * Format paragraphs properly — split by double newlines and wrap in <p> tags.
     * Also converts [N] citations to styled superscripts.
     */
    formatParagraphs(text) {
        if (!text) return "";
        const paragraphs = text.split(/\n\n+/).filter(p => p.trim());
        if (paragraphs.length <= 1) {
            return `<p>${this.formatCitations(text)}</p>`;
        }
        return paragraphs.map(p => `<p>${this.formatCitations(p.trim())}</p>`).join('\n');
    },

    /**
     * Convert inline [N] citations to styled superscripts.
     */
    formatCitations(text) {
        if (!text) return "";
        return text
            .replace(/\[Source (\d+)\]/g, '<sup>[$1]</sup>')
            .replace(/\[(\d+)\]/g, '<sup>[$1]</sup>');
    },

    /**
     * Convert number to Roman numerals for section headers.
     */
    toRoman(num) {
        const romanNumerals = [
            ['X', 10], ['IX', 9], ['V', 5], ['IV', 4], ['I', 1]
        ];
        let result = '';
        for (const [roman, value] of romanNumerals) {
            while (num >= value) {
                result += roman;
                num -= value;
            }
        }
        return result;
    },

    /**
     * Escape HTML special characters to prevent XSS in generated PDFs.
     */
    escapeHtml(text) {
        if (!text || typeof text !== 'string') return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
};

module.exports = pdfExportService;
