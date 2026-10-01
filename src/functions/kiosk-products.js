const { app } = require('@azure/functions');
const sql = require('mssql');

app.http('kiosk-products', {
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    authLevel: 'anonymous',
    route: 'kiosk/products/{id?}',
    handler: async (request, context) => {
        try {
            const pool = await sql.connect(process.env.SqlConnectionString);
            const id = parseId(request.params.id);

            if (request.params.id && !id) {
                return response(400, { error: 'Invalid product ID.' });
            }

            switch (request.method.toUpperCase()) {
                case 'GET': return await getProducts(pool, request, id);
                case 'POST': return await createProduct(pool, request);
                case 'PUT':
                    if (!id) return response(400, { error: 'Product ID is required.' });
                    return await updateProduct(pool, request, id);
                case 'DELETE':
                    if (!id) return response(400, { error: 'Product ID is required.' });
                    return await deactivateProduct(pool, id);
                default: return response(405, { error: 'Method not allowed.' });
            }
        } catch (error) {
            context.error('Kiosk products request failed', error);
            return databaseError(error, 'Kiosk products request failed.');
        }
    }
});

async function getProducts(pool, request, id) {
    if (id) {
        const result = await pool.request()
            .input('ProductID', sql.Int, id)
            .query(`
                SELECT ProductID, NameEn, NameSv, NameFi, PriceCents,
                       ImageUrl, Icon, IsActive, SortOrder, CreatedAt, UpdatedAt
                FROM dbo.KioskProducts
                WHERE ProductID = @ProductID;
            `);

        if (!result.recordset.length) return response(404, { error: 'Product not found.' });
        return response(200, mapProduct(result.recordset[0]));
    }

    const includeInactive = parseBoolean(request.query.get('includeInactive'), false);
    const result = await pool.request()
        .input('IncludeInactive', sql.Bit, includeInactive)
        .query(`
            SELECT ProductID, NameEn, NameSv, NameFi, PriceCents,
                   ImageUrl, Icon, IsActive, SortOrder, CreatedAt, UpdatedAt
            FROM dbo.KioskProducts
            WHERE @IncludeInactive = 1 OR IsActive = 1
            ORDER BY SortOrder, NameEn, ProductID;
        `);

    return response(200, result.recordset.map(mapProduct));
}

async function createProduct(pool, request) {
    const body = await readJson(request);
    const value = validateProduct(body);
    if (value.error) return response(400, { error: value.error });

    const result = await productRequest(pool.request(), value)
        .query(`
            INSERT dbo.KioskProducts
                (NameEn, NameSv, NameFi, PriceCents, ImageUrl, Icon, IsActive, SortOrder)
            OUTPUT inserted.*
            VALUES
                (@NameEn, @NameSv, @NameFi, @PriceCents, @ImageUrl, @Icon, @IsActive, @SortOrder);
        `);

    return response(201, mapProduct(result.recordset[0]));
}

async function updateProduct(pool, request, id) {
    const body = await readJson(request);
    const value = validateProduct(body);
    if (value.error) return response(400, { error: value.error });

    const result = await productRequest(
        pool.request().input('ProductID', sql.Int, id), value
    ).query(`
        UPDATE dbo.KioskProducts
        SET NameEn = @NameEn,
            NameSv = @NameSv,
            NameFi = @NameFi,
            PriceCents = @PriceCents,
            ImageUrl = @ImageUrl,
            Icon = @Icon,
            IsActive = @IsActive,
            SortOrder = @SortOrder,
            UpdatedAt = SYSUTCDATETIME()
        OUTPUT inserted.*
        WHERE ProductID = @ProductID;
    `);

    if (!result.recordset.length) return response(404, { error: 'Product not found.' });
    return response(200, mapProduct(result.recordset[0]));
}

async function deactivateProduct(pool, id) {
    const result = await pool.request()
        .input('ProductID', sql.Int, id)
        .query(`
            UPDATE dbo.KioskProducts
            SET IsActive = 0, UpdatedAt = SYSUTCDATETIME()
            OUTPUT inserted.*
            WHERE ProductID = @ProductID;
        `);

    if (!result.recordset.length) return response(404, { error: 'Product not found.' });
    return response(200, mapProduct(result.recordset[0]));
}

function validateProduct(body) {
    const nameEn = text(body.nameEn, 100);
    const nameSv = text(body.nameSv, 100);
    const nameFi = text(body.nameFi, 100);
    const priceCents = integer(body.priceCents);
    const sortOrder = integer(body.sortOrder ?? 0);

    if (!nameEn || !nameSv || !nameFi) return { error: 'nameEn, nameSv and nameFi are required.' };
    if (priceCents === null || priceCents < 0) return { error: 'priceCents must be a non-negative integer.' };
    if (sortOrder === null || sortOrder < 0) return { error: 'sortOrder must be a non-negative integer.' };

    return {
        nameEn, nameSv, nameFi, priceCents, sortOrder,
        imageUrl: nullableText(body.imageUrl, 500),
        icon: nullableText(body.icon, 20),
        isActive: parseBoolean(body.isActive, true)
    };
}

function productRequest(request, value) {
    return request
        .input('NameEn', sql.NVarChar(100), value.nameEn)
        .input('NameSv', sql.NVarChar(100), value.nameSv)
        .input('NameFi', sql.NVarChar(100), value.nameFi)
        .input('PriceCents', sql.Int, value.priceCents)
        .input('ImageUrl', sql.NVarChar(500), value.imageUrl)
        .input('Icon', sql.NVarChar(20), value.icon)
        .input('IsActive', sql.Bit, value.isActive)
        .input('SortOrder', sql.Int, value.sortOrder);
}

function mapProduct(row) {
    return {
        productId: row.ProductID,
        nameEn: row.NameEn,
        nameSv: row.NameSv,
        nameFi: row.NameFi,
        priceCents: row.PriceCents,
        imageUrl: row.ImageUrl,
        icon: row.Icon,
        isActive: Boolean(row.IsActive),
        sortOrder: row.SortOrder,
        createdAt: row.CreatedAt,
        updatedAt: row.UpdatedAt
    };
}

async function readJson(request) { try { return await request.json(); } catch { return {}; } }
function parseId(value) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : null; }
function integer(value) { const n = Number(value); return Number.isInteger(n) ? n : null; }
function text(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function nullableText(value, max) { const v = text(value, max); return v || null; }
function parseBoolean(value, fallback) { if (value === undefined || value === null || value === '') return fallback; return value === true || value === 1 || String(value).toLowerCase() === 'true' || String(value) === '1'; }
function response(status, jsonBody) { return { status, jsonBody }; }
function databaseError(error, message) {
    if (error.number === 2601 || error.number === 2627) return response(409, { error: 'A conflicting record already exists.', details: error.message });
    return response(500, { error: message, details: error.message });
}
