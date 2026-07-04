const pdf = require('pdf-parse');
const log = require('../utils/logger');

class PDFParserService {
  constructor() {}

  async parseSyllabus(pdfPath) {
    try {
      log.info('PDF Parser', `Parsing syllabus: ${pdfPath}`);

      const dataBuffer = require('fs').readFileSync(pdfPath);
      const pdfData = await pdf(dataBuffer);

      const semesterMap = this._extractSemesterMap(pdfData.text);
      const courses = this._extractCourses(pdfData.text, semesterMap);

      const structuredData = {
        metadata: {
          title: pdfData.info?.Title || 'Untitled Syllabus',
          author: pdfData.info?.Author || 'Unknown Author',
          subject: pdfData.info?.Subject || 'Course Syllabus',
          producer: pdfData.info?.Producer || 'PDF Generator',
          creationDate: pdfData.info?.CreationDate,
          modificationDate: pdfData.info?.ModDate,
        },
        totalPages: pdfData.numpages,
        rawText: pdfData.text,
        pages: this._splitIntoPages(pdfData.text),
        courses,
        parsedAt: new Date().toISOString(),
      };

      log.success('PDF Parser', `Successfully parsed syllabus with ${structuredData.totalPages} pages, ${courses.length} courses`);
      return structuredData;
    } catch (error) {
      log.error('PDF Parser', `Failed to parse syllabus: ${pdfPath}`, error);
      throw new Error(`PDF parsing failed: ${error.message}`);
    }
  }

  _splitIntoPages(text) {
    return text.split(/\n\n+/).map((page, index) => ({
      pageNumber: index + 1,
      text: page.trim(),
      wordCount: page.trim().split(/\s+/).length,
      charCount: page.length,
    }));
  }

  _extractSemesterMap(text) {
    const lines = text.split('\n');
    const map = {};
    let currentYear = '';
    let currentSem = '';

    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;

      const yearSemMatch = t.match(/^([IV]+)\s*[-–]\s*Year.*?([IV]+)\s*[-–]\s*Semester/);
      if (yearSemMatch) {
        currentYear = yearSemMatch[1];
        currentSem = yearSemMatch[2];
        continue;
      }

      const yearMatch = t.match(/^([IV]+)\s*[-–]\s*Year/);
      if (yearMatch && !t.match(/Semester/)) {
        currentYear = yearMatch[1];
        currentSem = '';
        continue;
      }

      const semMatch = t.match(/([IV]+)\s*[-–]\s*Semester/);
      if (semMatch && !t.match(/Year/)) {
        currentSem = semMatch[1];
        continue;
      }

      const codeMatch = t.match(/^\d+\s+([A-Z]{2}\d{4})\b/);
      if (codeMatch && currentYear && currentSem) {
        const code = codeMatch[1];
        if (!map[code]) {
          map[code] = currentYear + '-' + currentSem;
        }
      }
    }
    return map;
  }

  _extractCourses(text, semesterMap) {
    const lines = text.split('\n');
    const courseMap = new Map();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const header = this._matchHeader(lines, i);
      if (!header) continue;

      const endIdx = this._findCourseEnd(lines, header.startIdx);
      const courseText = lines.slice(header.startIdx, endIdx).join('\n');

      if (!this._hasContent(courseText)) continue;

      const existing = courseMap.get(header.code);
      if (!existing || (endIdx - header.startIdx) > (existing.endIdx - existing.startIdx)) {
        courseMap.set(header.code, {
          header,
          endIdx,
          courseText,
          startIdx: header.startIdx,
        });
      }
    }

    const sorted = [...courseMap.values()].sort((a, b) => a.startIdx - b.startIdx);
    return sorted.map(c => this._buildCourse(c.header, c.courseText, semesterMap));
  }

  _matchHeader(lines, startIdx) {
    const line = lines[startIdx].trim();
    let code, title, category, credits, ltp;

    // Format 1: CODE Title CAT L-T-P Credits (inline)
    let m = line.match(/^([A-Z]{2}\d{4})\s+(.+?)\s+(PCC|BSC|ESC|HSC|DEC|OEC|PRC|SLI|PEC)\s+(\d+[-–]\d+[-–]\d+)\s+(\d+)\s+Credits$/);
    if (m) {
      return { code: m[1], title: m[2].trim(), category: m[3], ltp: m[4], credits: m[5], startIdx };
    }

    // Format 2: CODE on its own line, then title, then "CAT L-T-P Credits" or "L-T-P Credits"
    if (/^[A-Z]{2}\d{4}$/.test(line)) {
      code = line;
      const titleLines = [];
      for (let j = startIdx + 1; j < Math.min(startIdx + 20, lines.length); j++) {
        const next = lines[j].trim();
        if (!next) continue;

        // Check for credit line: "CAT L-T-P Credits" or just "L-T-P Credits"
        let creditMatch = next.match(/^((PCC|BSC|ESC|HSC|DEC|OEC|PRC|SLI|PEC)\s+)?(\d+[-–]\d+[-–]\d+)\s+(\d+)\s+Credits$/);
        if (creditMatch) {
          category = creditMatch[2] || '';
          ltp = creditMatch[3];
          credits = creditMatch[4];
          break;
        }

        // Stop if we hit another course code
        if (/^[A-Z]{2}\d{4}(\s|$)/.test(next)) break;

        // Skip page header lines
        if (/^(Department of|Scheme and Syllabi)/.test(next)) continue;

        titleLines.push(next);
      }
      title = titleLines.join(' ').replace(/\s+/g, ' ').trim();
      if (code && title && ltp) {
        return { code, title, category: category || '', ltp, credits: credits || '', startIdx };
      }
    }

    // Format 3: CODE Title on same line but Credits on next line(s)
    m = line.match(/^([A-Z]{2}\d{4})\s+(.+)/);
    if (m) {
      code = m[1];
      const titleParts = [m[2].trim()];
      for (let j = startIdx + 1; j < Math.min(startIdx + 15, lines.length); j++) {
        const next = lines[j].trim();
        if (!next) continue;
        let cm = next.match(/^((PCC|BSC|ESC|HSC|DEC|OEC|PRC|SLI|PEC)\s+)?(\d+[-–]\d+[-–]\d+)\s+(\d+)\s+Credits$/);
        if (cm) {
          category = cm[2] || '';
          ltp = cm[3];
          credits = cm[4];
          break;
        }
        if (/^[A-Z]{2}\d{4}(\s|$)/.test(next)) break;
        if (/^(Department of|Scheme and Syllabi)/.test(next)) continue;
        titleParts.push(next);
      }
      title = titleParts.join(' ').replace(/\s+/g, ' ').trim();
      if (code && title && ltp) {
        return { code, title, category: category || '', ltp, credits: credits || '', startIdx };
      }
    }

    return null;
  }

  _findCourseEnd(lines, startIdx) {
    for (let j = startIdx + 1; j < lines.length; j++) {
      const line = lines[j].trim();
      if (!line) continue;
      if (/^(Department of|Scheme and Syllabi)/.test(line)) continue;
      const h = this._matchHeader(lines, j);
      if (h) return j;
    }
    return lines.length;
  }

  _hasContent(text) {
    return /Course Outcomes?:|Text Books?:|Syllabus:/i.test(text);
  }

  _buildCourse(header, courseText, semesterMap) {
    const prereq = this._extractSection(courseText, /Pre-requisites?:?\s*([^\n.]+)/i);
    const outcomes = this._extractOutcomes(courseText);
    const syllabusContent = this._extractSyllabusContent(courseText);
    const modules = this._extractModules(syllabusContent || courseText);
    const units = this._extractUnits(syllabusContent || courseText);
    const topics = this._extractTopics(syllabusContent);
    const textbooks = this._extractRefSection(courseText, /Text Books?:/i, /Reference Books?:/i);
    const refbooks = this._extractRefSection(courseText, /Reference Books?:/i, /Online\s+Resource/i);
    const onlineRes = this._extractRefSection(courseText, /Online\s+Resource/i, /Department of|^(?=[A-Z]{2}\d{4})/m);

    return {
      courseCode: header.code,
      courseName: header.title,
      semester: (semesterMap && semesterMap[header.code]) || '',
      credits: header.credits,
      category: header.category,
      prerequisite: prereq,
      outcomes,
      syllabusContent,
      modules,
      units,
      topics,
      textbooks: this._cleanRefs(textbooks),
      referenceBooks: this._cleanRefs(refbooks),
      onlineResources: this._cleanRefs(onlineRes),
    };
  }

  _extractSection(text, regex) {
    const m = text.match(regex);
    return m ? m[1].trim() : '';
  }

  _extractOutcomes(text) {
    const outcomes = [];
    const rx = /(CO\d+)\s+(.+?)(?=\nCO\d+|\nSyllabus:|$)/gs;
    let m;
    while ((m = rx.exec(text)) !== null) {
      outcomes.push(m[1] + ' ' + m[2].trim());
    }
    if (outcomes.length === 0) {
      const alt = text.match(/Course Outcomes?:?\s*([\s\S]+?)(?=\nSyllabus:|$)/i);
      if (alt) outcomes.push(alt[1].trim());
    }
    return outcomes.join('; ').replace(/\s+/g, ' ');
  }

  _extractSyllabusContent(text) {
    const m = text.match(/Syllabus:\s*\n([\s\S]+?)(?=\n\s*Text Books?:|$)/i);
    if (m) return m[1].trim();

    const m2 = text.match(/Syllabus:\s*([\s\S]+?)(?=\n\s*Text Books?:|$)/i);
    return m2 ? m2[1].trim() : '';
  }

  _extractModules(text) {
    const modules = [];
    const rx = /Module\s+(\d+)\s*:?\s*([A-Za-z0-9\s\-/]+?)(?=\nModule\s+\d+|$)/gi;
    let m;
    while ((m = rx.exec(text)) !== null) {
      const title = m[2].trim();
      if (title && title.length < 100) {
        modules.push({ moduleNumber: m[1], moduleTitle: title });
      }
    }
    return modules;
  }

  _extractUnits(text) {
    const units = [];
    const rx = /Unit\s+(\d+)\s*:?\s*([A-Za-z0-9\s\-/]+?)(?=\nUnit\s+\d+|$)/gi;
    let m;
    while ((m = rx.exec(text)) !== null) {
      const title = m[2].trim();
      if (title && title.length < 100) {
        units.push({ unitNumber: m[1], unitTitle: title });
      }
    }
    return units;
  }

  _extractTopics(syllabusContent) {
    const topics = [];
    if (!syllabusContent) return topics;

    const lines = syllabusContent.split('\n').map(l => l.trim()).filter(Boolean);
    let current = '';

    for (const line of lines) {
      const isHeading = /^[A-Z][A-Za-z0-9\s\-/,]{5,}:\s/.test(line);
      if (isHeading) {
        if (current) topics.push({ text: current });
        current = line;
      } else {
        current = current ? current + ' ' + line : line;
      }
    }
    if (current) topics.push({ text: current });

    return topics;
  }

  _extractRefSection(text, startRegex, endRegex) {
    const lines = text.split('\n');
    let capturing = false;
    const parts = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (startRegex.test(trimmed)) { capturing = true; continue; }
      if (capturing && endRegex.test(trimmed)) break;
      if (capturing && trimmed) parts.push(trimmed);
    }
    return parts.join('\n');
  }

  _cleanRefs(text) {
    if (!text) return '';
    return text.split('\n')
      .map(l => l.replace(/^\d+\.?\s*/, '').trim())
      .filter(l => l && !/^Department of/i.test(l) && !/^Scheme and Syllabi/i.test(l))
      .join('; ');
  }

  async parseDepartmentSyllabus(department) {
    const pdfPath = require('path').join(__dirname, '../course_bootstrap', department, 'syllabus.pdf');
    return this.parseSyllabus(pdfPath);
  }
}

module.exports = PDFParserService;
