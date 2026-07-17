// server/routes/files.js
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { authMiddleware } = require('../middleware/authMiddleware');
const User = require('../models/User');
const axios = require('axios');
const router = express.Router();

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const BACKUP_DIR = path.join(__dirname, '..', 'backup_assets');

// --- Helper functions ---
const sanitizeUsernameForDir = (username) => {
    if (!username) return '';
    return username.replace(/[^a-zA-Z0-9_-]/g, '_');
};

const parseServerFilename = (filename) => {
    const match = filename.match(/^(\d+)-(.+?)(\.\w+)$/);
    if (match && match.length === 4) {
        return { timestamp: match[1], originalName: `${match[2]}${match[3]}`, extension: match[3] };
    }
    const ext = path.extname(filename);
    const baseWithoutExt = filename.substring(0, filename.length - ext.length);
    const tsMatch = baseWithoutExt.match(/^(\d+)-(.*)$/);
    if (tsMatch) {
        return { timestamp: tsMatch[1], originalName: `${tsMatch[2]}${ext}`, extension: ext };
    }
    return { timestamp: null, originalName: filename, extension: path.extname(filename) };
};

const ensureDirExists = async (dirPath) => {
    try { await fs.mkdir(dirPath, { recursive: true }); }
    catch (error) { if (error.code !== 'EEXIST') { throw error; } }
};

async function callPythonDeletionEndpoint(method, endpointPath, userId, originalName, logContext) {
    const pythonServiceUrl = process.env.PYTHON_RAG_SERVICE_URL;
    if (!pythonServiceUrl) {
        console.error(`Python Service Deletion Error for ${logContext}: PYTHON_RAG_SERVICE_URL not set.`);
        return { success: false, message: 'Python service URL not configured.' };
    }
    const deleteUrl = `${pythonServiceUrl.replace(/\/$/, '')}${endpointPath}`;
    try {
        let response;
        if (method.toUpperCase() === 'DELETE') {
            response = await axios.delete(deleteUrl, {
                data: { user_id: userId, document_name: originalName },
                timeout: 30000
            });
        } else {
            throw new Error(`Unsupported method: ${method}`);
        }
        if (response.status === 200 || response.status === 204) {
            return { success: true, message: response.data?.message || `Deleted from ${endpointPath}` };
        }
        return { success: false, message: response.data?.message || `Python returned ${response.status}` };
    } catch (error) {
        const msg = error.response?.data?.error || error.response?.data?.message || error.message;
        console.error(`Python deletion error (${deleteUrl}): ${msg}`);
        return { success: false, message: `Python call failed: ${msg}` };
    }
}
// --- End Helper Functions ---

// @route   GET /api/files
// @desc    Get uploaded file list for authenticated user
router.get('/', authMiddleware, async (req, res) => {
    try {
        const userId = req.user._id.toString();
        const user = await User.findById(userId).select('uploadedDocuments');
        if (!user) return res.status(404).json({ msg: 'User not found' });
        const filenames = user.uploadedDocuments
            .map(doc => doc.filename)
            .filter(Boolean)
            .reverse();
        return res.json({ filenames });
    } catch (error) {
        console.error('GET /api/files error:', error.message);
        return res.status(500).json({ msg: 'Server error' });
    }
});

// @route   DELETE /api/files/:serverFilename
// @desc    Delete user file — cleans MongoDB, Qdrant vectors, Neo4j KG nodes, and filesystem
router.delete('/:serverFilename', authMiddleware, async (req, res) => {
    const { serverFilename } = req.params;
    const userId = req.user._id.toString();
    const usernameForLog = req.user.username;

    if (!serverFilename) {
        return res.status(400).json({ message: 'Server filename parameter is required.' });
    }

    const parsedFileDetails = parseServerFilename(serverFilename);
    const originalName = parsedFileDetails.originalName;
    if (!originalName) {
        return res.status(400).json({ message: 'Invalid server filename format for deletion.' });
    }
    const logContext = `File: '${originalName}' (server: ${serverFilename}), User: ${usernameForLog} (${userId})`;
    console.log(`Attempting to delete all data for ${logContext}`);

    const results = {
        mongodb: { success: false, message: 'Not attempted' },
        qdrant: { success: false, message: 'Not attempted' },
        neo4j: { success: false, message: 'Not attempted' },
        filesystem: { success: false, message: 'Not attempted' },
    };
    let fileFoundInMongo = false;
    let physicalFileFound = false;

    try {
        // 1. Remove from MongoDB
        try {
            const user = await User.findById(userId);
            if (!user) {
                results.mongodb.message = 'User not found.';
            } else {
                const docIndex = user.uploadedDocuments.findIndex(doc => doc.filename === originalName);
                if (docIndex > -1) {
                    fileFoundInMongo = true;
                    user.uploadedDocuments.splice(docIndex, 1);
                    await user.save();
                    results.mongodb.success = true;
                    results.mongodb.message = `Removed '${originalName}' from user document list.`;
                } else {
                    results.mongodb.message = 'Document not found in user list.';
                }
            }
        } catch (mongoError) {
            console.error(`MongoDB Deletion Error for ${logContext}:`, mongoError);
            results.mongodb.message = `MongoDB deletion failed: ${mongoError.message}`;
        }

        // 2. Delete Qdrant vectors
        results.qdrant = await callPythonDeletionEndpoint(
            'DELETE', `/delete_qdrant_document_data`, userId, originalName, logContext
        );

        // 3. Delete Neo4j KG nodes
        results.neo4j = await callPythonDeletionEndpoint(
            'DELETE', `/kg/${userId}/${encodeURIComponent(originalName)}`, userId, originalName, logContext
        );
        if (!results.neo4j.success) {
            console.warn(`Neo4j deletion issue for ${logContext}: ${results.neo4j.message}`);
        }

        // 4. Move physical file to backup
        const sanitizedUsername = sanitizeUsernameForDir(usernameForLog);
        const fileTypesToSearch = ['docs', 'images', 'code', 'others'];
        let currentPath = null;
        let fileType = '';

        for (const type of fileTypesToSearch) {
            const potentialPath = path.join(ASSETS_DIR, sanitizedUsername, type, serverFilename);
            try {
                await fs.access(potentialPath);
                currentPath = potentialPath;
                fileType = type;
                physicalFileFound = true;
                break;
            } catch (e) {
                if (e.code !== 'ENOENT') console.warn(`Filesystem access error at ${potentialPath}: ${e.message}`);
            }
        }

        if (currentPath) {
            const backupUserDir = path.join(BACKUP_DIR, sanitizedUsername, fileType);
            await ensureDirExists(backupUserDir);
            const backupDest = path.join(backupUserDir, serverFilename);
            await fs.rename(currentPath, backupDest);
            results.filesystem.success = true;
            results.filesystem.message = `Moved '${serverFilename}' to backup.`;
        } else {
            results.filesystem.message = 'Physical file not found in assets directory.';
        }

        const successfulDeletes = Object.values(results).filter(r => r.success).length;
        let httpStatus = 200;
        let finalMessage;

        if (!fileFoundInMongo && !physicalFileFound) {
            httpStatus = 404;
            finalMessage = `File '${originalName}' not found for user.`;
        } else if (results.mongodb.success) {
            finalMessage = successfulDeletes === 4
                ? `Successfully deleted all data for '${originalName}'.`
                : `File '${originalName}' removed. Some cleanup steps had issues — check server logs.`;
            httpStatus = successfulDeletes === 4 ? 200 : 207;
        } else {
            httpStatus = 500;
            finalMessage = `Failed to remove '${originalName}' from user list. Check server logs.`;
        }

        return res.status(httpStatus).json({ message: finalMessage, details: results });

    } catch (error) {
        console.error(`Unexpected error in DELETE /api/files/${serverFilename}:`, error);
        return res.status(500).json({ message: 'Unexpected server error during deletion.', details: results });
    }
});


module.exports = router;
