const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');
const sql = require('mssql');
const crypto = require('crypto');
const path = require('path');

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Map([
    ['image/jpeg', '.jpg'],
    ['image/png', '.png'],
    ['image/webp', '.webp'],
    ['image/gif', '.gif']
]);

app.http('images-list', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'images',
    handler: async (request, context) => {
        try {
            const pool = await sql.connect(process.env.SqlConnectionString);
            const result = await pool.request().query(`
                SELECT
                    ia.ImageAssetID,
                    ia.DisplayName,
                    ia.BlobName,
                    ia.OriginalFileName,
                    ia.ContentType,
                    ia.FileSize,
                    ia.Width,
                    ia.Height,
                    ia.CreatedAt,
                    ia.CreatedBy,
                    COUNT(kp.ProductID) AS ProductUsageCount
                FROM dbo.ImageAssets ia
                LEFT JOIN dbo.KioskProducts kp
                    ON kp.ImageAssetID = ia.ImageAssetID
                GROUP BY
                    ia.ImageAssetID,
                    ia.DisplayName,
                    ia.BlobName,
                    ia.OriginalFileName,
                    ia.ContentType,
                    ia.FileSize,
                    ia.Width,
                    ia.Height,
                    ia.CreatedAt,
                    ia.CreatedBy
                ORDER BY ia.DisplayName, ia.OriginalFileName, ia.ImageAssetID;
            `);

            return response(200, result.recordset.map(row => mapImage(row, request)));
        } catch (error) {
            context.error('Image list request failed', error);
            return databaseError(error, 'Image list request failed.');
        }
    }
});

app.http('images-get', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'images/{id:int}',
    handler: async (request, context) => {
        try {
            const id = parseId(request.params.id);
            if (!id) {
                return response(400, { error: 'Invalid image asset ID.' });
            }

            const pool = await sql.connect(process.env.SqlConnectionString);
            const image = await getImageMetadata(pool, id);

            if (!image) {
                return response(404, { error: 'Image asset not found.' });
            }

            return response(200, mapImage(image, request));
        } catch (error) {
            context.error('Image metadata request failed', error);
            return databaseError(error, 'Image metadata request failed.');
        }
    }
});

app.http('images-content', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'images/{id:int}/content',
    handler: async (request, context) => {
        try {
            const id = parseId(request.params.id);
            if (!id) {
                return response(400, { error: 'Invalid image asset ID.' });
            }

            const pool = await sql.connect(process.env.SqlConnectionString);
            const image = await getImageMetadata(pool, id);

            if (!image) {
                return response(404, { error: 'Image asset not found.' });
            }

            const blobClient = getContainerClient().getBlobClient(image.BlobName);
            const exists = await blobClient.exists();

            if (!exists) {
                return response(404, { error: 'Image file not found in Blob Storage.' });
            }

            const download = await blobClient.download();
            const buffer = await streamToBuffer(download.readableStreamBody);

            return {
                status: 200,
                headers: {
                    'Content-Type': image.ContentType,
                    'Content-Length': String(buffer.length),
                    'Cache-Control': 'public, max-age=3600',
                    'Content-Disposition': `inline; filename="${safeHeaderFileName(image.OriginalFileName)}"`
                },
                body: buffer
            };
        } catch (error) {
            context.error('Image content request failed', error);
            return serviceError(error, 'Image content request failed.');
        }
    }
});

app.http('images-upload', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'images/upload',
    handler: async (request, context) => {
        let uploadedBlobName = null;

        try {
            const formData = await request.formData();
            const file = formData.get('file');

            if (!file || typeof file.arrayBuffer !== 'function') {
                return response(400, {
                    error: 'A multipart/form-data field named file is required.'
                });
            }

            const contentType = normalizeContentType(file.type);
            if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
                return response(400, {
                    error: 'Unsupported image type. Allowed types are JPEG, PNG, WebP and GIF.'
                });
            }

            if (!Number.isFinite(file.size) || file.size <= 0) {
                return response(400, { error: 'The uploaded image is empty.' });
            }

            if (file.size > MAX_FILE_SIZE) {
                return response(413, { error: 'The uploaded image exceeds the 5 MB limit.' });
            }

            const originalFileName = cleanFileName(file.name || 'image');
            const displayName = text(formData.get('displayName'), 255)
                || path.parse(originalFileName).name.slice(0, 255)
                || 'Image';
            const createdBy = nullableText(formData.get('createdBy'), 100);
            const extension = ALLOWED_CONTENT_TYPES.get(contentType);
            uploadedBlobName = `products/${crypto.randomUUID()}${extension}`;

            const buffer = Buffer.from(await file.arrayBuffer());
            const blockBlobClient = getContainerClient().getBlockBlobClient(uploadedBlobName);

            await blockBlobClient.uploadData(buffer, {
                blobHTTPHeaders: {
                    blobContentType: contentType,
                    blobCacheControl: 'public, max-age=3600'
                },
                metadata: {
                    originalfilename: metadataValue(originalFileName),
                    displayname: metadataValue(displayName)
                }
            });

            const pool = await sql.connect(process.env.SqlConnectionString);
            const result = await pool.request()
                .input('DisplayName', sql.NVarChar(255), displayName)
                .input('BlobName', sql.NVarChar(500), uploadedBlobName)
                .input('OriginalFileName', sql.NVarChar(255), originalFileName)
                .input('ContentType', sql.NVarChar(100), contentType)
                .input('FileSize', sql.BigInt, buffer.length)
                .input('CreatedBy', sql.NVarChar(100), createdBy)
                .query(`
                    INSERT INTO dbo.ImageAssets
                    (
                        DisplayName,
                        BlobName,
                        OriginalFileName,
                        ContentType,
                        FileSize,
                        Width,
                        Height,
                        CreatedBy
                    )
                    OUTPUT
                        inserted.ImageAssetID,
                        inserted.DisplayName,
                        inserted.BlobName,
                        inserted.OriginalFileName,
                        inserted.ContentType,
                        inserted.FileSize,
                        inserted.Width,
                        inserted.Height,
                        inserted.CreatedAt,
                        inserted.CreatedBy
                    VALUES
                    (
                        @DisplayName,
                        @BlobName,
                        @OriginalFileName,
                        @ContentType,
                        @FileSize,
                        NULL,
                        NULL,
                        @CreatedBy
                    );
                `);

            return response(201, mapImage(result.recordset[0], request));
        } catch (error) {
            context.error('Image upload request failed', error);

            if (uploadedBlobName) {
                try {
                    await getContainerClient()
                        .getBlockBlobClient(uploadedBlobName)
                        .deleteIfExists();
                } catch (cleanupError) {
                    context.error('Failed to clean up blob after image upload error', cleanupError);
                }
            }

            if (isFormDataError(error)) {
                return response(400, {
                    error: 'The request must use multipart/form-data.',
                    details: error.message
                });
            }

            return serviceError(error, 'Image upload request failed.');
        }
    }
});

app.http('images-delete', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'images/{id:int}',
    handler: async (request, context) => {
        try {
            const id = parseId(request.params.id);
            if (!id) {
                return response(400, { error: 'Invalid image asset ID.' });
            }

            const pool = await sql.connect(process.env.SqlConnectionString);
            const image = await getImageMetadata(pool, id);

            if (!image) {
                return response(404, { error: 'Image asset not found.' });
            }

            const usageResult = await pool.request()
                .input('ImageAssetID', sql.Int, id)
                .query(`
                    SELECT COUNT(*) AS UsageCount
                    FROM dbo.KioskProducts
                    WHERE ImageAssetID = @ImageAssetID;
                `);

            const usageCount = Number(usageResult.recordset[0].UsageCount);
            if (usageCount > 0) {
                return response(409, {
                    error: 'The image is assigned to one or more kiosk products and cannot be deleted.',
                    productUsageCount: usageCount
                });
            }

            await getContainerClient()
                .getBlockBlobClient(image.BlobName)
                .deleteIfExists();

            await pool.request()
                .input('ImageAssetID', sql.Int, id)
                .query(`
                    DELETE FROM dbo.ImageAssets
                    WHERE ImageAssetID = @ImageAssetID;
                `);

            return response(200, {
                deleted: true,
                imageAssetId: id,
                blobName: image.BlobName
            });
        } catch (error) {
            context.error('Image delete request failed', error);
            return serviceError(error, 'Image delete request failed.');
        }
    }
});

async function getImageMetadata(pool, id) {
    const result = await pool.request()
        .input('ImageAssetID', sql.Int, id)
        .query(`
            SELECT
                ia.ImageAssetID,
                ia.DisplayName,
                ia.BlobName,
                ia.OriginalFileName,
                ia.ContentType,
                ia.FileSize,
                ia.Width,
                ia.Height,
                ia.CreatedAt,
                ia.CreatedBy,
                (
                    SELECT COUNT(*)
                    FROM dbo.KioskProducts kp
                    WHERE kp.ImageAssetID = ia.ImageAssetID
                ) AS ProductUsageCount
            FROM dbo.ImageAssets ia
            WHERE ia.ImageAssetID = @ImageAssetID;
        `);

    return result.recordset[0] || null;
}


async function streamToBuffer(readableStream) {
    if (!readableStream) {
        throw new Error('Blob download returned no readable stream.');
    }

    const chunks = [];
    for await (const chunk of readableStream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
}

function getContainerClient() {
    const connectionString = process.env.ImageStorageConnection;
    const containerName = process.env.ImageContainerName;

    if (!connectionString) {
        throw new Error('ImageStorageConnection app setting is missing.');
    }

    if (!containerName) {
        throw new Error('ImageContainerName app setting is missing.');
    }

    return BlobServiceClient
        .fromConnectionString(connectionString)
        .getContainerClient(containerName);
}

function mapImage(row, request) {
    const imageAssetId = Number(row.ImageAssetID);

    return {
        imageAssetId,
        displayName: row.DisplayName,
        originalFileName: row.OriginalFileName,
        contentType: row.ContentType,
        fileSize: row.FileSize === null || row.FileSize === undefined
            ? null
            : Number(row.FileSize),
        width: row.Width,
        height: row.Height,
        createdAt: row.CreatedAt,
        createdBy: row.CreatedBy,
        productUsageCount: Number(row.ProductUsageCount || 0),
        contentUrl: absoluteApiUrl(request, `/api/images/${imageAssetId}/content`)
    };
}

function absoluteApiUrl(request, relativePath) {
    const url = new URL(request.url);
    return `${url.protocol}//${url.host}${relativePath}`;
}

function parseId(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeContentType(value) {
    return String(value || '').toLowerCase().split(';')[0].trim();
}

function cleanFileName(value) {
    const baseName = path.basename(String(value || 'image'));
    const cleaned = baseName.replace(/[\x00-\x1f\x7f]/g, '').trim();
    return (cleaned || 'image').slice(0, 255);
}

function safeHeaderFileName(value) {
    return cleanFileName(value).replace(/["\\]/g, '_');
}

function metadataValue(value) {
    return String(value || '')
        .normalize('NFKD')
        .replace(/[^\x20-\x7E]/g, '')
        .slice(0, 1024);
}

function text(value, maxLength) {
    return typeof value === 'string'
        ? value.trim().slice(0, maxLength)
        : '';
}

function nullableText(value, maxLength) {
    const parsed = text(value, maxLength);
    return parsed || null;
}

function isFormDataError(error) {
    const message = String(error && error.message || '').toLowerCase();
    return message.includes('form') || message.includes('multipart');
}

function response(status, jsonBody) {
    return { status, jsonBody };
}

function databaseError(error, message) {
    if (error.number === 2601 || error.number === 2627) {
        return response(409, {
            error: 'A conflicting image record already exists.',
            details: error.message
        });
    }

    if (error.number === 547) {
        return response(409, {
            error: 'The requested change conflicts with existing data or a database constraint.',
            details: error.message
        });
    }

    return response(500, {
        error: message,
        details: error.message
    });
}

function serviceError(error, message) {
    if (error && error.number !== undefined) {
        return databaseError(error, message);
    }

    return response(500, {
        error: message,
        details: error && error.message ? error.message : String(error)
    });
}
