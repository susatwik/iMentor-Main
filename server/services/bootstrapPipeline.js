const fs = require('fs-extra');
const path = require('path');
const log = require('../utils/logger');
class BootstrapPipeline {
  constructor() {
    this.servicesPath = path.join(__dirname, '');
  }

  async runPipeline(department = 'EE') {
    try {
      log.info('Bootstrap Pipeline', `Starting bootstrap pipeline for department: ${department}`);

      const results = {
        parser: null,
        csvGenerator: null,
        validator: null,
        startTime: new Date().toISOString(),
      };

      const pdfPath = path.join(__dirname, '../course_bootstrap', department, 'syllabus.pdf');
      const csvOutputPath = path.join(__dirname, '../course_bootstrap', department, 'syllabus.csv');

      if (!fs.existsSync(pdfPath)) {
        throw new Error(`PDF file not found: ${pdfPath}`);
      }

      log.info('Bootstrap Pipeline', `Found syllabus PDF: ${pdfPath}`);

      const pdfParserService = new (require('./pdfParserService.js'))();
      log.info('Bootstrap Pipeline', 'Step 1: Parsing PDF syllabus...');
      results.parser = await pdfParserService.parseDepartmentSyllabus(department);

      const syllabusCsvGenerator = new (require('./syllabusCsvGenerator.js'))({ department, programme: 'B.Tech', regulation: 'R24' });
      log.info('Bootstrap Pipeline', 'Step 2: Generating CSV from parsed data...');
      results.csvGenerator = await syllabusCsvGenerator.generateCsv(results.parser, csvOutputPath);

      const syllabusValidator = new (require('./syllabusValidator.js'))();
      log.info('Bootstrap Pipeline', 'Step 3: Validating generated CSV...');
      results.validator = await syllabusValidator.validateDepartmentSyllabus(department);

      if (!results.validator.isValid) {
        throw new Error('CSV validation failed. Please check the validation report.');
      }

      results.endTime = new Date().toISOString();
      results.duration = this._calculateDuration(results.startTime, results.endTime);

      log.success('Bootstrap Pipeline', `Pipeline completed successfully in ${results.duration}ms`);
      log.success('Bootstrap Pipeline', `Generated ${results.csvGenerator.recordsCount} records in CSV`);
      log.success('Bootstrap Pipeline', `Output: ${csvOutputPath}`);

      return results;
    } catch (error) {
      log.error('Bootstrap Pipeline', `Pipeline failed: ${error.message}`, error);
      throw new Error(`Bootstrap pipeline failed: ${error.message}`);
    }
  }

  _calculateDuration(startTime, endTime) {
    const start = new Date(startTime);
    const end = new Date(endTime);
    return end - start;
  }

  async run() {
    const department = process.argv[2] || 'EE';
    return this.runPipeline(department);
  }
}

if (require.main === module) {
  const pipeline = new BootstrapPipeline();
  pipeline.run().catch(error => {
    log.error('Bootstrap Pipeline', 'Fatal error:', error);
    process.exit(1);
  });
}

module.exports = BootstrapPipeline;
