const log = require('../utils/logger');
class SyllabusValidator {
  constructor(options = {}) {
    this.requiredColumns = [
      'Department',
      'Programme',
      'Regulation',
      'Semester',
      'CourseCode',
      'CourseTitle',
      'Credits',
      'Category',
      'CourseType',
      'Prerequisites',
      'CourseOutcome',
      'ModuleNumber',
      'ModuleTitle',
      'UnitNumber',
      'UnitTitle',
      'Topic',
      'SubTopic',
      'Keywords',
      'TextBook',
      'ReferenceBook',
      'OnlineResource',
      'Remarks',
    ];
  }

  async validateCsv(csvPath) {
    try {
      const fs = require('fs');
      const csvContent = fs.readFileSync(csvPath, 'utf8');
      const lines = csvContent.split('\n');

      if (lines.length < 2) {
        throw new Error('CSV file is empty');
      }

      const headers = this._parseCsvLine(lines[0]);
      const dataRows = lines.slice(1, lines.length - 1);

      const validationReport = this._performValidation(dataRows, headers);

      if (!validationReport.isValid) {
        log.warn('Syllabus Validator', 'CSV validation failed with errors');
        this._logValidationReport(validationReport);
        return validationReport;
      }

      log.success('Syllabus Validator', 'CSV validation passed successfully');
      return validationReport;
    } catch (error) {
      log.error('Syllabus Validator', `Failed to validate CSV: ${csvPath}`, error);
      throw new Error(`CSV validation failed: ${error.message}`);
    }
  }

  _performValidation(dataRows, headers) {
    const report = {
      isValid: true,
      errors: [],
      warnings: [],
      stats: { totalRows: dataRows.length },
    };

    const missingColumns = this._checkRequiredColumns(headers);
    if (missingColumns.length > 0) {
      report.isValid = false;
      report.errors.push(`Missing required columns: ${missingColumns.join(', ')}`);
    }

    const duplicateCourseCodes = this._checkDuplicateCourseCodes(dataRows);
    if (duplicateCourseCodes.length > 0) {
      report.isValid = false;
      report.errors.push(`Duplicate course codes found: ${duplicateCourseCodes.join(', ')}`);
    }

    const duplicateRows = this._checkDuplicateRows(dataRows);
    if (duplicateRows.length > 0) {
      report.isValid = false;
      report.errors.push(`Duplicate rows found at lines: ${duplicateRows.join(', ')}`);
    }

    const emptyModules = this._checkEmptyModules(dataRows);
    if (emptyModules.length > 0) {
      report.warnings.push(`Empty modules found at lines: ${emptyModules.join(', ')}`);
    }

    const missingTopics = this._checkMissingTopics(dataRows);
    if (missingTopics.length > 0) {
      report.warnings.push(`Missing topics found at lines: ${missingTopics.join(', ')}`);
    }

    const missingCourseOutcomes = this._checkMissingCourseOutcomes(dataRows);
    if (missingCourseOutcomes.length > 0) {
      report.warnings.push(`Missing course outcomes found at lines: ${missingCourseOutcomes.join(', ')}`);
    }

    const missingTextbooks = this._checkMissingTextbooks(dataRows);
    if (missingTextbooks.length > 0) {
      report.warnings.push(`Missing textbooks found at lines: ${missingTextbooks.join(', ')}`);
    }

    return report;
  }

  _checkRequiredColumns(headers) {
    const missingColumns = [];
    for (const column of this.requiredColumns) {
      if (!headers.includes(column)) {
        missingColumns.push(column);
      }
    }
    return missingColumns;
  }

  _checkDuplicateCourseCodes(dataRows) {
    const courseKeys = new Set();
    const duplicates = [];

    for (let i = 0; i < dataRows.length; i++) {
      const columns = this._parseCsvLine(dataRows[i]);
      if (columns.length < 16) continue;
      const courseCode = columns[4];
      const moduleNum = columns[11] || '';
      const moduleTitle = columns[12] || '';
      const unitNum = columns[13] || '';
      const unitTitle = columns[14] || '';
      const topic = columns[15] || '';
      if (!courseCode) continue;
      const key = `${courseCode}|${moduleNum}|${moduleTitle}|${unitNum}|${unitTitle}|${topic}`;
      if (courseKeys.has(key)) {
        duplicates.push(courseCode);
      } else {
        courseKeys.add(key);
      }
    }

    return Array.from(new Set(duplicates));
  }

  _checkDuplicateRows(dataRows) {
    const rowHashes = {};
    const duplicates = [];

    for (let i = 0; i < dataRows.length; i++) {
      const rowHash = this._hashRow(dataRows[i]);
      if (rowHashes[rowHash]) {
        duplicates.push(i + 2);
      } else {
        rowHashes[rowHash] = true;
      }
    }

    return duplicates;
  }

  _hashRow(row) {
    return row.trim();
  }

  _checkEmptyModules(dataRows) {
    const emptyModules = [];

    for (let i = 0; i < dataRows.length; i++) {
      const columns = this._parseCsvLine(dataRows[i]);
      if (columns.length < 13) continue;
      const moduleNumber = columns[11];
      const moduleTitle = columns[12];
      const unitNumber = columns[13];
      const unitTitle = columns[14];
      const topic = columns[15];

      if (!moduleTitle || (!unitTitle && !topic)) {
        emptyModules.push(i + 2);
      }
    }

    return emptyModules;
  }

  _checkMissingTopics(dataRows) {
    const missingTopics = [];

    for (let i = 0; i < dataRows.length; i++) {
      const columns = this._parseCsvLine(dataRows[i]);
      if (columns.length < 16) continue;
      const topic = columns[15];

      if (!topic) {
        missingTopics.push(i + 2);
      }
    }

    return missingTopics;
  }

  _checkMissingCourseOutcomes(dataRows) {
    const missingOutcomes = [];

    for (let i = 0; i < dataRows.length; i++) {
      const columns = this._parseCsvLine(dataRows[i]);
      if (columns.length < 11) continue;
      const courseOutcome = columns[10];

      if (!courseOutcome) {
        missingOutcomes.push(i + 2);
      }
    }

    return missingOutcomes;
  }

  _checkMissingTextbooks(dataRows) {
    const missingTextbooks = [];

    for (let i = 0; i < dataRows.length; i++) {
      const columns = this._parseCsvLine(dataRows[i]);
      if (columns.length < 18) continue;
      const textbook = columns[17];

      if (!textbook) {
        missingTextbooks.push(i + 2);
      }
    }

    return missingTextbooks;
  }

  _parseCsvLine(line) {
    const columns = [];
    let currentColumn = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"' && (i === 0 || line[i - 1] !== '\\')) {
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

  _logValidationReport(report) {
    if (report.errors.length > 0) {
      log.error('Syllabus Validator', 'Validation errors:', report.errors.join(', '));
    }

    if (report.warnings.length > 0) {
      log.warn('Syllabus Validator', 'Validation warnings:', report.warnings.join(', '));
    }

    log.info('Syllabus Validator', `Validation complete. Total rows: ${report.stats.totalRows}`);
  }

  async validateDepartmentSyllabus(department) {
    const csvPath = require('path').join(__dirname, '../course_bootstrap', department, 'syllabus.csv');
    return this.validateCsv(csvPath);
  }
}

module.exports = SyllabusValidator;
