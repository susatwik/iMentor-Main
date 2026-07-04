/**
 * Converts the 22-column EE syllabus CSV into the 5-column unified format
 * that the Python RAG pipeline (curriculum_graph_handler) expects.
 *
 * Unified format: Module, Lecture Number, Lecture Topic, Subtopics, Resources
 *
 * Mapping:
 *   Module        → Semester column (e.g., "I-I", "II-II")
 *   Lecture Number → auto-incremented within each semester
 *   Lecture Topic  → CourseCode - CourseTitle (e.g., "EE1011 - Basic Electrical Circuits")
 *   Subtopics      → comma-separated Topic values from all rows for that course
 *   Resources      → TextBook; ReferenceBook; OnlineResource from first row of course
 */

const fs = require('fs-extra');
const path = require('path');
const log = require('../../utils/logger');

class EeCsvToUnifiedConverter {
  convert(csvPath, outputPath) {
    log.info('EE→Unified Converter', `Converting ${csvPath} → ${outputPath}`);

    const csv = fs.readFileSync(csvPath, 'utf8');
    const rows = this._parseCsv(csv);

    if (rows.length < 2) {
      throw new Error('CSV has no data rows');
    }

    const headers = rows[0];
    const colMap = this._buildColumnMap(headers);
    const dataRows = rows.slice(1);

    const courses = this._groupByCourse(dataRows, colMap);
    const unified = this._buildUnifiedRows(courses, colMap);

    const output = this._formatCsv(unified);
    fs.writeFileSync(outputPath, output, 'utf8');

    log.success('EE→Unified Converter', `Wrote ${unified.length} unified rows to ${outputPath}`);
    return { rows: unified.length, outputPath };
  }

  _parseCsv(csv) {
    const lines = [];
    let current = '';
    let inQuotes = false;

    for (const ch of csv) {
      if (ch === '"') {
        inQuotes = !inQuotes;
        current += ch;
      } else if (ch === '\n' && !inQuotes) {
        if (current.trim()) lines.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) lines.push(current);

    return lines.map(line => {
      const cols = [];
      let cur = '';
      let q = false;
      for (const ch of line) {
        if (ch === '"') { q = !q; cur += ch; }
        else if (ch === ',' && !q) { cols.push(cur.trim()); cur = ''; }
        else cur += ch;
      }
      cols.push(cur.trim());
      return cols.map(c => {
        if (c.startsWith('"') && c.endsWith('"')) {
          return c.slice(1, -1).replace(/""/g, '"');
        }
        return c;
      });
    });
  }

  _buildColumnMap(headers) {
    const map = {};
    headers.forEach((h, i) => {
      const key = h.replace(/['"]/g, '').trim().toLowerCase();
      if (key === 'semester') map.semester = i;
      else if (key === 'coursecode') map.courseCode = i;
      else if (key === 'coursetitle') map.courseTitle = i;
      else if (key === 'topic') map.topic = i;
      else if (key === 'subtopic') map.subTopic = i;
      else if (key === 'textbook') map.textBook = i;
      else if (key === 'referencebook') map.referenceBook = i;
      else if (key === 'onlineresource') map.onlineResource = i;
    });
    return map;
  }

  _groupByCourse(rows, colMap) {
    const groups = {};
    for (const row of rows) {
      const code = row[colMap.courseCode] || '';
      if (!code) continue;
      if (!groups[code]) groups[code] = [];
      groups[code].push(row);
    }
    return groups;
  }

  _buildUnifiedRows(courses, colMap) {
    const unified = [];
    const semOrder = [];

    for (const [code, rows] of Object.entries(courses)) {
      const first = rows[0];
      const sem = first[colMap.semester] || '';
      const title = first[colMap.courseTitle] || '';

      const topics = rows
        .map(r => r[colMap.topic] || '')
        .filter(Boolean);
      const subTopics = rows
        .map(r => r[colMap.subTopic] || '')
        .filter(Boolean);

      const subtopics = [...topics, ...subTopics]
        .map(s => s.replace(/:[^,;]*$/, '').trim())
        .filter(Boolean);

      const uniqueSubtopics = [...new Set(subtopics)].join(', ');

      const resources = [
        first[colMap.textBook] || '',
        first[colMap.referenceBook] || '',
        first[colMap.onlineResource] || '',
      ].filter(Boolean).join('; ');

      unified.push({
        module: sem,
        lectureTopic: `${code} - ${title}`,
        subtopics: uniqueSubtopics,
        resources,
      });
    }

    unified.sort((a, b) => {
      const semA = a.module || '';
      const semB = b.module || '';
      if (semA !== semB) return semA.localeCompare(semB);
      return a.lectureTopic.localeCompare(b.lectureTopic);
    });

    let currentSem = '';
    let lecNum = 0;
    return unified.map(u => {
      if (u.module !== currentSem) {
        currentSem = u.module;
        lecNum = 0;
      }
      lecNum++;
      return {
        module: u.module,
        lectureNumber: lecNum,
        lectureTopic: u.lectureTopic,
        subtopics: u.subtopics,
        resources: u.resources,
      };
    });
  }

  _escapeCsv(value) {
    if (value == null) return '';
    const s = String(value);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  _formatCsv(rows) {
    const header = 'Module,Lecture Number,Lecture Topic,Subtopics,Resources';
    const lines = [header];
    for (const r of rows) {
      lines.push([
        this._escapeCsv(r.module),
        this._escapeCsv(r.lectureNumber),
        this._escapeCsv(r.lectureTopic),
        this._escapeCsv(r.subtopics),
        this._escapeCsv(r.resources),
      ].join(','));
    }
    return lines.join('\n') + '\n';
  }
}

if (require.main === module) {
  const dept = process.argv[2] || 'EE';
  const eeDir = path.join(__dirname, '../../course_bootstrap', dept);
  const src = path.join(eeDir, 'syllabus.csv');
  const dst = path.join(eeDir, 'syllabus_unified.csv');
  const conv = new EeCsvToUnifiedConverter();
  conv.convert(src, dst);
}

module.exports = EeCsvToUnifiedConverter;
