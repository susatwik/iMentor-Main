/**
 * Course Data Extractor
 * Implements Task 2.1.2: Course content extraction
 * Parses uploaded PDFs and docs into raw structural text for the Q&A generator.
 */

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse'); // Now a real implementation

const AdminDocument = require('../models/AdminDocument');

/**
 * Parses an uploaded course document and extracts its raw text
 * @param {String} filePath - Absolute path to the uploaded file
 * @param {String} courseName - Target course for tagging
 */
async function extractTextFromCourseMaterial(filePath, courseName) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    console.log(`[DataExtractor] Extracting content from ${path.basename(filePath)} for course [${courseName}]...`);

    try {
        const dataBuffer = fs.readFileSync(filePath);
        const data = await pdfParse(dataBuffer);

        console.log(`[DataExtractor] Successfully extracted ${data.numpages} pages of text.`);
        return data.text.trim();
    } catch (error) {
        console.error(`[DataExtractor] Failed to parse PDF: ${error.message}`);
        throw error;
    }
}

/**
 * Chunks massive documents into manageable context windows for the Q&A generator
 */
function chunkExtractedText(rawText, maxWordsPerChunk = 500) {
    const words = rawText.split(/\s+/);
    const chunks = [];

    for (let i = 0; i < words.length; i += maxWordsPerChunk) {
        chunks.push(words.slice(i, i + maxWordsPerChunk).join(" "));
    }

    console.log(`[DataExtractor] Split text into ${chunks.length} processing chunks.`);
    return chunks;
}

/**
 * Retrieves the text content of a course document from the AdminDocument collection
 * @param {String} subjectName - The original name of the subject document
 * @returns {String|null} - The extracted text or null if not found
 */
async function getCourseContent(subjectName) {
    console.log(`[DataExtractor] Retrieving content for [${subjectName}] from AdminDocuments...`);
    try {
        const doc = await AdminDocument.findOne({ originalName: subjectName }).select('text');
        return doc ? doc.text : null;
    } catch (error) {
        console.error(`[DataExtractor] Error retrieving course content: ${error.message}`);
        return null;
    }
}

module.exports = {
    extractTextFromCourseMaterial,
    chunkExtractedText,
    getCourseContent
};
