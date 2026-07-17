const fs = require('fs').promises; // Use fs.promises for async operations
const path = require('path');
const log = require('./logger');

// ... (Constants remain same)
const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const BACKUP_DIR = path.join(__dirname, '..', 'backup_assets');
const FOLDER_TYPES = ['docs', 'images', 'code', 'others'];

/**
 * Moves existing user asset folders to backup location on server startup.
 */
async function performAssetCleanup() {
    // log.info('SYSTEM', "Starting asset cleanup...");
    try {
        await fs.mkdir(BACKUP_DIR, { recursive: true });

        let userDirs = [];
        try {
            userDirs = await fs.readdir(ASSETS_DIR);
        } catch (err) {
            if (err.code === 'ENOENT') {
                log.info('SYSTEM', "Assets directory initialized");
                await fs.mkdir(ASSETS_DIR, { recursive: true });
                return;
            }
            throw err;
        }

        if (userDirs.length === 0) {
             // log.info('SYSTEM', "No assets to clean up");
             return;
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

        for (const userName of userDirs) {
            const userAssetPath = path.join(ASSETS_DIR, userName);
            const userBackupPathBase = path.join(BACKUP_DIR, userName);
            const userTimestampBackupPath = path.join(userBackupPathBase, `backup_${timestamp}`);

            try {
                const stats = await fs.stat(userAssetPath);
                if (!stats.isDirectory()) continue;

                // log.info('SYSTEM', `Cleaning assets for user: ${userName}`);
                let backupDirCreated = false;
                let movedSomething = false;

                for (const type of FOLDER_TYPES) {
                    const sourceTypePath = path.join(userAssetPath, type);
                    try {
                        await fs.access(sourceTypePath);

                        if (!backupDirCreated) {
                            await fs.mkdir(userTimestampBackupPath, { recursive: true });
                            backupDirCreated = true;
                        }

                        const backupTypePath = path.join(userTimestampBackupPath, type);
                        await fs.rename(sourceTypePath, backupTypePath);
                        movedSomething = true;

                    } catch (accessErr) {
                        if (accessErr.code !== 'ENOENT') {
                            log.error('SYSTEM', `Asset access error (${type})`, accessErr);
                        }
                    }

                    try {
                        await fs.mkdir(sourceTypePath, { recursive: true });
                    } catch (mkdirErr) {
                         log.error('SYSTEM', `Asset directory creation failed (${type})`, mkdirErr);
                    }
                }

                 if (movedSomething) {
                     log.success('SYSTEM', `Assets backed up for ${userName}`);
                 }
            } catch (userDirStatErr) {
                 log.error('SYSTEM', `User asset processing failed (${userName})`, userDirStatErr);
            }
        }
    } catch (error) {
        log.error('SYSTEM', "Critical Error during Asset Cleanup", error);
    }
}

// Export the function to be used elsewhere
module.exports = { performAssetCleanup };
