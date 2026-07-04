const fs = require('fs-extra');
const log = require('../utils/logger');

class SyllabusCsvGenerator {
  constructor(options = {}) {
    this.defaultOptions = {
      department: options.department || 'UNKNOWN',
      programme: options.programme || 'B.Tech',
      regulation: options.regulation || 'R24',
    };
    this.options = { ...this.defaultOptions, ...options };
  }

  async generateCsv(parsedData, outputPath) {
    try {
      log.info('CSV Generator', `Generating syllabus CSV: ${outputPath}`);

      const records = this._normalizeToRecords(parsedData);
      const csvHeaders = this._getCsvHeaders();
      const csvContent = this._buildCsvContent(records, csvHeaders);

      await fs.writeFile(outputPath, csvContent, 'utf8');

      log.success('CSV Generator', `Successfully generated ${records.length} records to ${outputPath}`);

      return {
        success: true,
        recordsCount: records.length,
        outputPath,
      };
    } catch (error) {
      log.error('CSV Generator', `Failed to generate CSV: ${outputPath}`, error);
      throw new Error(`CSV generation failed: ${error.message}`);
    }
  }

  _normalizeToRecords(parsedData) {
    const records = [];

    if (!parsedData.courses || !Array.isArray(parsedData.courses)) {
      return records;
    }

    for (const course of parsedData.courses) {
      const base = {
        department: this.options.department,
        programme: this.options.programme,
        regulation: this.options.regulation,
        semester: course.semester || this.options.semester || '',
        courseCode: course.courseCode || '',
        courseTitle: course.courseName || '',
        credits: course.credits || '',
        category: course.category || '',
        courseType: '',
        prerequisites: course.prerequisite || '',
        courseOutcome: course.outcomes || '',
        moduleNumber: '',
        moduleTitle: '',
        unitNumber: '',
        unitTitle: '',
        topic: '',
        subTopic: '',
        keywords: '',
        textBook: course.textbooks || '',
        referenceBook: course.referenceBooks || '',
        onlineResource: course.onlineResources || '',
        remarks: '',
      };

      const hasModules = course.modules && course.modules.length > 0;
      const hasUnits = course.units && course.units.length > 0;
      const hasTopics = course.topics && course.topics.length > 0;

      if (hasTopics) {
        for (const topic of course.topics) {
          const record = { ...base };
          record.topic = topic.text || '';

          if (hasModules && topic.moduleIndex !== undefined) {
            const mod = course.modules[topic.moduleIndex];
            record.moduleNumber = mod.moduleNumber || '';
            record.moduleTitle = mod.moduleTitle || '';
          }

          if (hasUnits && topic.unitIndex !== undefined) {
            const unt = course.units[topic.unitIndex];
            record.unitNumber = unt.unitNumber || '';
            record.unitTitle = unt.unitTitle || '';
          }

          records.push(record);
        }
      } else {
        records.push({ ...base });
      }
    }

    return records;
  }

  _getCsvHeaders() {
    return [
      'Department', 'Programme', 'Regulation', 'Semester',
      'CourseCode', 'CourseTitle', 'Credits', 'Category',
      'CourseType', 'Prerequisites', 'CourseOutcome',
      'ModuleNumber', 'ModuleTitle', 'UnitNumber', 'UnitTitle',
      'Topic', 'SubTopic', 'Keywords',
      'TextBook', 'ReferenceBook', 'OnlineResource', 'Remarks',
    ];
  }

  _buildCsvContent(records, headers) {
    const fieldMap = {
      Department: 'department',
      Programme: 'programme',
      Regulation: 'regulation',
      Semester: 'semester',
      CourseCode: 'courseCode',
      CourseTitle: 'courseTitle',
      Credits: 'credits',
      Category: 'category',
      CourseType: 'courseType',
      Prerequisites: 'prerequisites',
      CourseOutcome: 'courseOutcome',
      ModuleNumber: 'moduleNumber',
      ModuleTitle: 'moduleTitle',
      UnitNumber: 'unitNumber',
      UnitTitle: 'unitTitle',
      Topic: 'topic',
      SubTopic: 'subTopic',
      Keywords: 'keywords',
      TextBook: 'textBook',
      ReferenceBook: 'referenceBook',
      OnlineResource: 'onlineResource',
      Remarks: 'remarks',
    };

    const escapeCsv = (field) => {
      if (!field) return '';
      let fieldStr = String(field).replace(/\s+/g, ' ').trim();
      if (fieldStr.includes(',') || fieldStr.includes('"')) {
        return '"' + fieldStr.replace(/"/g, '""') + '"';
      }
      return fieldStr;
    };

    const csvLines = [headers.join(',')];

    for (const record of records) {
      const values = headers.map(header => {
        const key = fieldMap[header];
        return escapeCsv(key ? record[key] || '' : '');
      });
      csvLines.push(values.join(','));
    }

    return csvLines.join('\n');
  }

  async generateDepartmentCsv(department) {
    const pdfPath = require('path').join(__dirname, '../course_bootstrap', department, 'syllabus.pdf');
    const outputPath = require('path').join(__dirname, '../course_bootstrap', department, 'syllabus.csv');

    const parser = new (require('./pdfParserService.js'))();
    const parsedData = await parser.parseSyllabus(pdfPath);

    const generator = new SyllabusCsvGenerator({
      department,
      programme: 'B.Tech',
      regulation: 'R24',
    });

    return generator.generateCsv(parsedData, outputPath);
  }
}

module.exports = SyllabusCsvGenerator;
