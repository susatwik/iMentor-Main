const log = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

const S3_BUCKET = process.env.S3_BUCKET_NAME;
const AWS_REGION = process.env.AWS_REGION;
const ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;

// Validate AWS region to prevent SDK vulnerability (GHSA-j965-2qgj-vjmq)
const VALID_AWS_REGIONS = new Set([
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'af-south-1', 'ap-east-1', 'ap-south-1', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3', 'ap-southeast-1', 'ap-southeast-2',
  'ca-central-1', 'eu-central-1', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-north-1', 'eu-south-1',
  'me-south-1', 'sa-east-1'
]);

const validatedRegion = VALID_AWS_REGIONS.has(AWS_REGION) ? AWS_REGION : 'us-east-1';

// Check if AWS is configured properly (not placeholders/empty)
const isAwsConfigured = 
    ACCESS_KEY_ID && 
    SECRET_ACCESS_KEY && 
    ACCESS_KEY_ID !== "ADD_YOUR_AWS_ACCESS_KEY_ID_HERE" && 
    !ACCESS_KEY_ID.includes("ADD_YOUR") &&
    SECRET_ACCESS_KEY !== "ADD_YOUR_AWS_SECRET_ACCESS_KEY_HERE";

let s3;
let AWS;

if (isAwsConfigured) {
    try {
        AWS = require('aws-sdk');
        
        AWS.config.update({
            region: validatedRegion,
            accessKeyId: ACCESS_KEY_ID,
            secretAccessKey: SECRET_ACCESS_KEY,
        });

        s3 = new AWS.S3({
            signatureVersion: 'v4',
        });
        log.success('SYSTEM', 'AWS S3 Service initialized');
    } catch (err) {
        log.warn('SYSTEM', `Failed to load AWS SDK: ${err.message}`);
    }
} else {
    // log.info('SYSTEM', 'AWS Credentials not found. S3 features will be mocked.');
}

async function getSignedUploadUrl(fileName, fileType) {
    if (!s3) {
        // log.info('SYSTEM', `Generating mock upload URL for ${fileName}`);
        return { 
            url: "http://localhost:5001/mock-s3-upload", // Dummy URL
            key: `datasets/mock-${uuidv4()}-${fileName}` 
        };
    }

    const key = `datasets/${uuidv4()}-${fileName}`;
    const params = {
        Bucket: S3_BUCKET,
        Key: key,
        Expires: 120, // URL expires in 2 minutes
        ContentType: fileType,
    };

    const url = await s3.getSignedUrlPromise('putObject', params);
    return { url, key };
}

async function getSignedDownloadUrl(key, originalName) {
    if (!s3) {
        // log.info('SYSTEM', `Generating mock download URL for ${key}`);
        return "http://localhost:5001/mock-s3-download"; // Dummy URL
    }

    const params = {
        Bucket: S3_BUCKET,
        Key: key,
        Expires: 120, // URL expires in 2 minutes
        ResponseContentDisposition: `attachment; filename="${originalName}"`,
    };

    const url = await s3.getSignedUrlPromise('getObject', params);
    return url;
}

async function deleteObjectFromS3(key) {
    if (!s3) {
        // log.info('SYSTEM', `Mock deletion of object: ${key}`);
        return { success: true };
    }

    const params = {
        Bucket: S3_BUCKET,
        Key: key,
    };

    try {
        await s3.deleteObject(params).promise();
        log.info('SYSTEM', `S3 object deleted: ${key}`);
        return { success: true };
    } catch (error) {
        log.error('SYSTEM', `Error deleting S3 object: ${key}`, error);
        throw new Error(`Failed to delete file from S3: ${error.message}`);
    }
}

module.exports = {
    getSignedUploadUrl,
    getSignedDownloadUrl,
    deleteObjectFromS3,
};
