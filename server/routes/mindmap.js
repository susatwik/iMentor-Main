const log = require('../utils/logger');
// server/routes/mindmap.js
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const User = require('../models/User'); // For a more advanced implementation

// @route   GET /api/mindmap
// @desc    Get Mermaid code for a mind map
// @access  Private (requires auth)
router.get('/', authMiddleware, async (req, res) => {
    const userId = req.user._id; // User is authenticated
    // log.info('DB', `Mindmap request: ${userId}`);

    try {
        const user = await User.findById(userId).select('uploadedDocuments.filename uploadedDocuments.analysis.mindmap'); // Select only necessary fields
        
        let mindmapCode = null;
        let sourceDocumentName = "Unknown Document";

        if (user && user.uploadedDocuments && user.uploadedDocuments.length > 0) {
            // Find the most recent document that has a mindmap analysis.
            // This assumes higher index means more recent, or you'd sort by an explicit timestamp if available.
            for (let i = user.uploadedDocuments.length - 1; i >= 0; i--) {
                const doc = user.uploadedDocuments[i];
                if (doc.analysis && typeof doc.analysis.mindmap === 'string' && doc.analysis.mindmap.trim() !== "") {
                    mindmapCode = doc.analysis.mindmap.trim();
                    sourceDocumentName = doc.filename || "Untitled Document";
                    // log.info('DB', `Found mindmap for ${sourceDocumentName}`);
                    break;
                }
            }
        }

        if (mindmapCode) {
            // Basic check if the code starts with a known Mermaid diagram type.
            // This is a simple heuristic. Robust validation is complex.
            const trimmedCode = mindmapCode; // Already trimmed
            const validMermaidPrefixes = ['mindmap', 'graph', 'flowchart', 'sequenceDiagram', 'gantt', 'classDiagram', 'stateDiagram', 'pie', 'erDiagram', 'journey', 'requirementDiagram', 'gitGraph'];
            
            const isPotentiallyValidMermaid = validMermaidPrefixes.some(prefix => 
                trimmedCode.toLowerCase().startsWith(prefix)
            );

            if (!isPotentiallyValidMermaid) {
                // If the stored code doesn't look like Mermaid, prepend 'mindmap'
                // This is an assumption that the stored data *should* be a mindmap if it's in this field.
                // log.warn('DB', `Mindmap code for '${sourceDocumentName}' missing Mermaid prefix`);
                mindmapCode = `mindmap\n${trimmedCode}`; 
            } else if (!trimmedCode.toLowerCase().startsWith('mindmap')) {
                 // If it's valid Mermaid but not explicitly 'mindmap' (e.g. 'graph TD'),
                 // and the user specifically clicked "Mind Map", it's still okay to send.
                 // The Mermaid library on the frontend can render various diagram types.
                // log.info('DB', "Sending stored Mermaid diagram");
            }
            return res.status(200).json({ mermaidCode: mindmapCode, source: sourceDocumentName });
        } else {
            // log.info('DB', `No mindmap found for user ${userId}`);
            const defaultMermaidCode = `
mindmap
  root((No Mind Map Available))
    (Please upload a document and ensure its analysis includes a mind map.)
    (Or, no documents processed yet.)
`;
            return res.status(200).json({ mermaidCode: defaultMermaidCode, source: "Default" });
        }

    } catch (error) {
        log.error('DB', `Mindmap fetch error: ${error.message}`);
        res.status(500).json({ message: "Failed to retrieve mind map code due to a server error." });
    }
});

module.exports = router;