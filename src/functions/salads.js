const { app } = require('@azure/functions');
const sql = require('mssql');

const route = 'salads/{id?}';

app.http('salads', {
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    authLevel: 'anonymous',
    route,
    handler: async (request, context) => {
        try {
            const pool = await sql.connect(process.env.SqlConnectionString);
            const method = request.method.toUpperCase();
            const id = parseId(request.params.id);

            if (request.params.id && !id) {
                return response(400, { error: 'Invalid salad ID.' });
            }

            switch (method) {
                case 'GET':
                    return await getSalads(pool, request, id);
                case 'POST':
                    return await createSalad(pool, request);
                case 'PUT':
                    if (!id) return response(400, { error: 'Salad ID is required.' });
                    return await updateSalad(pool, request, id);
                case 'DELETE':
                    if (!id) return response(400, { error: 'Salad ID is required.' });
                    return await deactivateSalad(pool, id);
                default:
                    return response(405, { error: 'Method not allowed.' });
            }
        } catch (error) {
            context.error('Salad API request failed', error);
            return response(500, {
                error: 'Salad API request failed.',
                details: error.message
            });
        }
    }
});

async function getSalads(pool, request, id) {
    if (id) {
        const result = await pool.request()
            .input('SaladID', sql.Int, id)
            .query(`
                SELECT SaladID, NameEn, NameSv, NameFi, IsActive,
                       SortOrder, CreatedAt, UpdatedAt
                FROM dbo.Salads
                WHERE SaladID = @SaladID;
            `);

        if (!result.recordset.length) {
            return response(404, { error: 'Salad not found.' });
        }

        return response(200, mapSalad(result.recordset[0]));
    }

    const includeInactive = parseBoolean(request.query.get('includeInactive'), false);
    const result = await pool.request()
        .input('IncludeInactive', sql.Bit, includeInactive)
        .query(`
            SELECT SaladID, NameEn, NameSv, NameFi, IsActive,
                   SortOrder, CreatedAt, UpdatedAt
            FROM dbo.Salads
            WHERE @IncludeInactive = 1 OR IsActive = 1
            ORDER BY SortOrder, NameEn, SaladID;
        `);

    return response(200, result.recordset.map(mapSalad));
}

async function createSalad(pool, request) {
    const body = await readJson(request);
    const validation = validateSalad(body);
    if (validation.error) return response(400, { error: validation.error });

    const result = await pool.request()
        .input('NameEn', sql.NVarChar(100), validation.nameEn)
        .input('NameSv', sql.NVarChar(100), validation.nameSv)
        .input('NameFi', sql.NVarChar(100), validation.nameFi)
        .input('IsActive', sql.Bit, validation.isActive)
        .input('SortOrder', sql.Int, validation.sortOrder)
        .query(`
            INSERT dbo.Salads (NameEn, NameSv, NameFi, IsActive, SortOrder)
            OUTPUT inserted.SaladID, inserted.NameEn, inserted.NameSv,
                   inserted.NameFi, inserted.IsActive, inserted.SortOrder,
                   inserted.CreatedAt, inserted.UpdatedAt
            VALUES (@NameEn, @NameSv, @NameFi, @IsActive, @SortOrder);
        `);

    return response(201, mapSalad(result.recordset[0]));
}

async function updateSalad(pool, request, id) {
    const body = await readJson(request);
    const validation = validateSalad(body);
    if (validation.error) return response(400, { error: validation.error });

    const result = await pool.request()
        .input('SaladID', sql.Int, id)
        .input('NameEn', sql.NVarChar(100), validation.nameEn)
        .input('NameSv', sql.NVarChar(100), validation.nameSv)
        .input('NameFi', sql.NVarChar(100), validation.nameFi)
        .input('IsActive', sql.Bit, validation.isActive)
        .input('SortOrder', sql.Int, validation.sortOrder)
        .query(`
            UPDATE dbo.Salads
            SET NameEn = @NameEn,
                NameSv = @NameSv,
                NameFi = @NameFi,
                IsActive = @IsActive,
                SortOrder = @SortOrder,
                UpdatedAt = SYSUTCDATETIME()
            OUTPUT inserted.SaladID, inserted.NameEn, inserted.NameSv,
                   inserted.NameFi, inserted.IsActive, inserted.SortOrder,
                   inserted.CreatedAt, inserted.UpdatedAt
            WHERE SaladID = @SaladID;
        `);

    if (!result.recordset.length) {
        return response(404, { error: 'Salad not found.' });
    }

    return response(200, mapSalad(result.recordset[0]));
}

async function deactivateSalad(pool, id) {
    // Soft delete preserves historical references from lunch orders.
    const result = await pool.request()
        .input('SaladID', sql.Int, id)
        .query(`
            UPDATE dbo.Salads
            SET IsActive = 0,
                UpdatedAt = SYSUTCDATETIME()
            OUTPUT inserted.SaladID, inserted.NameEn, inserted.NameSv,
                   inserted.NameFi, inserted.IsActive, inserted.SortOrder,
                   inserted.CreatedAt, inserted.UpdatedAt
            WHERE SaladID = @SaladID;
        `);

    if (!result.recordset.length) {
        return response(404, { error: 'Salad not found.' });
    }

    return response(200, mapSalad(result.recordset[0]));
}

function validateSalad(body) {
    const nameEn = cleanText(body.nameEn, 100);
    const nameSv = cleanText(body.nameSv, 100);
    const nameFi = cleanText(body.nameFi, 100);
    const sortOrder = Number(body.sortOrder ?? 0);

    if (!nameEn || !nameSv || !nameFi) {
        return { error: 'nameEn, nameSv and nameFi are required.' };
    }
    if (!Number.isInteger(sortOrder) || sortOrder < 0) {
        return { error: 'sortOrder must be a non-negative integer.' };
    }

    return {
        nameEn,
        nameSv,
        nameFi,
        sortOrder,
        isActive: parseBoolean(body.isActive, true)
    };
}

async function readJson(request) {
    try {
        return await request.json();
    } catch {
        return {};
    }
}

function parseId(value) {
    if (!value) return null;
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
}

function cleanText(value, maxLength) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, maxLength);
}

function parseBoolean(value, defaultValue) {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    return String(value).toLowerCase() === 'true' || String(value) === '1';
}

function mapSalad(row) {
    return {
        saladId: row.SaladID,
        nameEn: row.NameEn,
        nameSv: row.NameSv,
        nameFi: row.NameFi,
        isActive: Boolean(row.IsActive),
        sortOrder: row.SortOrder,
        createdAt: row.CreatedAt,
        updatedAt: row.UpdatedAt
    };
}

function response(status, jsonBody) {
    return { status, jsonBody };
}
