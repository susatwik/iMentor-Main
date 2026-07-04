const fs = require('fs-extra');
const log = require('../utils/logger');

class KeywordGenerator {
  constructor(options = {}) {
    this.tokenizer = { tokenize: (text) => text.split(/[^a-zA-Z0-9']+/).filter(Boolean) };
    this.stopWords = options.stopWords || [
      'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from',
      'has', 'he', 'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the',
      'to', 'was', 'were', 'will', 'with', 'basic', 'introduction', 'course',
      'electrical', 'engineering', 'analysis', 'circuit', 'digital', 'system',
    ];
    this.minWordLength = options.minWordLength || 3;
    this.maxKeywords = options.maxKeywords || 20;
    this.confidenceThreshold = options.confidenceThreshold || 0.3;
  }

  async generateKeywords(text, context = {}) {
    try {
      log.info('Keyword Generator', `Generating keywords for: ${text.substring(0, 100)}...`);

      const words = this._extractSignificantWords(text);
      const normalizedKeywords = this._normalizeKeywords(words);
      const scoredKeywords = this._scoreKeywords(normalizedKeywords, text);

      const topKeywords = scoredKeywords
        .sort((a, b) => b.score - a.score)
        .slice(0, this.maxKeywords)
        .filter(kw => kw.score >= this.confidenceThreshold)
        .map(kw => kw.keyword);

      log.success('Keyword Generator', `Generated ${topKeywords.length} keywords`);

      return topKeywords;
    } catch (error) {
      log.error('Keyword Generator', 'Failed to generate keywords', error);
      return [];
    }
  }

  _extractSignificantWords(text) {
    const words = this.tokenizer.tokenize(text.toLowerCase());
    const filtered = words.filter(word =>
      word.length >= this.minWordLength &&
      !this.stopWords.includes(word) &&
      !/^[0-9]+$/.test(word) &&
      !/^[^a-zA-Z0-9]+$/.test(word)
    );

    return filtered;
  }

  _normalizeKeywords(words) {
    const normalized = {};

    for (const word of words) {
      const normalizedWord = word.toLowerCase().trim();
      if (!normalized[normalizedWord]) {
        normalized[normalizedWord] = [];
      }
      normalized[normalizedWord].push(word);
    }

    return normalized;
  }

  _scoreKeywords(keywordMap, text) {
    const scoredKeywords = [];

    for (const [normalized, variants] of Object.entries(keywordMap)) {
      let score = 0;
      let totalFrequency = 0;

      for (const variant of variants) {
        const regex = new RegExp(`\b${variant}\b`, 'gi');
        const matches = text.match(regex);
        const frequency = matches ? matches.length : 0;

        totalFrequency += frequency;
        score += frequency * this._getWeightByLength(variant);
      }

      const normalizedScore = Math.min(1.0, totalFrequency / 10);

      scoredKeywords.push({
        keyword: normalized,
        score: normalizedScore,
        frequency: totalFrequency,
        variants: variants,
      });
    }

    return scoredKeywords;
  }

  _getWeightByLength(word) {
    if (word.length <= 3) return 0.5;
    if (word.length <= 5) return 1.0;
    if (word.length <= 8) return 1.5;
    return 2.0;
  }

  async generateKeywordsForRecord(topic, subTopic, context = {}) {
    const combinedText = `${topic} ${subTopic} ${context.courseTitle || ''} ${context.courseDescription || ''}`.trim();
    if (!combinedText) return '';

    const keywords = await this.generateKeywords(combinedText, context);
    return keywords.join(', ');
  }

  async processCsvWithKeywords(csvPath, outputPath) {
    try {
      log.info('Keyword Generator', `Processing CSV for keyword generation: ${csvPath}`);

      const csvContent = await fs.readFile(csvPath, 'utf8');
      const lines = csvContent.split('\n');

      if (lines.length < 2) {
        throw new Error('CSV file is empty or has no data');
      }

      const headers = lines[0].split(',').map(h => h.trim());
      const dataRows = lines.slice(1, lines.length - 1);

      const updatedLines = [lines[0]];

      for (const row of dataRows) {
        const columns = this._parseCsvRow(row);
        if (!columns || columns.length !== headers.length) continue;

        const rowData = {};
        for (let i = 0; i < headers.length; i++) {
          rowData[headers[i]] = columns[i] || '';
        }

        const keywords = await this.generateKeywordsForRecord(
          rowData['Topic'] || '',
          rowData['SubTopic'] || '',
          {
            courseTitle: rowData['CourseTitle'] || '',
            courseDescription: `${rowData['CourseTitle'] || ''}`
          }
        );

        rowData['Keywords'] = keywords;

        const updatedRow = headers.map(header => {
          const value = rowData[header] || '';
          return this._escapeCsvField(value);
        }).join(',');

        updatedLines.push(updatedRow);
      }

      const updatedCsvContent = updatedLines.join('\n');
      await fs.writeFile(outputPath, updatedCsvContent, 'utf8');

      log.success('Keyword Generator', `Successfully added keywords to ${outputPath}`);

      return {
        success: true,
        recordsProcessed: dataRows.length,
        outputPath,
      };
    } catch (error) {
      log.error('Keyword Generator', `Failed to process CSV: ${csvPath}`, error);
      throw new Error(`Keyword generation failed: ${error.message}`);
    }
  }

  _parseCsvRow(row) {
    const columns = [];
    let currentColumn = '';
    let inQuotes = false;

    for (let i = 0; i < row.length; i++) {
      const char = row[i];

      if (char === '"' && (i === 0 || row[i - 1] !== '\\')) {
        inQuotes = !inQuotes;
        currentColumn += char;
      } else if (char === ',' && !inQuotes) {
        columns.push(currentColumn.trim());
        currentColumn = '';
      } else {
        currentColumn += char;
      }
    }

    columns.push(currentColumn.trim());
    return columns;
  }

  _escapeCsvField(field) {
    if (!field) return '';
    const fieldStr = String(field);
    if (fieldStr.includes(',') || fieldStr.includes('|') || fieldStr.includes('\"')) {
      return `\"${fieldStr.replace(/\"/g, '\"\"')}\"`;
    }
    return fieldStr;
  }

  async generateDepartmentKeywords(department) {
    const csvPath = require('path').join(__dirname, '../course_bootstrap', department, 'syllabus.csv');
    const outputPath = require('path').join(__dirname, '../course_bootstrap', department, 'syllabus_keywords_added.csv');

    const generator = new KeywordGenerator();
    return generator.processCsvWithKeywords(csvPath, outputPath);
  }
}

module.exports = KeywordGenerator;

