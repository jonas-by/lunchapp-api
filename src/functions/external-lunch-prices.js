const { app } = require('@azure/functions');
const sql = require('mssql');

app.http('external-lunch-prices', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    route: 'external-lunch-prices',
    handler: async (request, context) => {
        try {
            const pool = await sql.connect(process.env.SqlConnectionString);
            if (request.method === 'GET') return await readPrices(pool);
            return await savePrice(pool, request);
        } catch (error) {
            context.error('External lunch prices request failed', error);
            return { status: 500, jsonBody: { error: 'External lunch prices request failed', details: error.message } };
        }
    }
});

async function readPrices(pool) {
    const result = await pool.request().query(`
        SELECT ExternalLunchPriceID, PriceCents, ValidFrom, CreatedAt, CreatedBy
        FROM dbo.ExternalLunchPrices
        ORDER BY ValidFrom DESC, ExternalLunchPriceID DESC;
    `);
    return {
        status: 200,
        jsonBody: {
            current: result.recordset[0] ? mapPrice(result.recordset[0]) : null,
            prices: result.recordset.map(mapPrice)
        }
    };
}

async function savePrice(pool, request) {
    let body;
    try { body = await request.json(); }
    catch { return bad('Request body must contain valid JSON.'); }

    const priceCents = Number(body.priceCents);
    const validFrom = typeof body.validFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.validFrom)
        ? body.validFrom : null;
    const createdBy = body.createdBy == null ? null : String(body.createdBy).trim().slice(0, 255) || null;

    if (!Number.isInteger(priceCents) || priceCents <= 0) return bad('priceCents must be a positive integer.');
    if (!validFrom) return bad('validFrom must use YYYY-MM-DD format.');

    try {
        const result = await pool.request()
            .input('PriceCents', sql.Int, priceCents)
            .input('ValidFrom', sql.Date, validFrom)
            .input('CreatedBy', sql.NVarChar(255), createdBy)
            .query(`
                INSERT dbo.ExternalLunchPrices (PriceCents, ValidFrom, CreatedBy)
                OUTPUT inserted.ExternalLunchPriceID, inserted.PriceCents,
                       inserted.ValidFrom, inserted.CreatedAt, inserted.CreatedBy
                VALUES (@PriceCents, @ValidFrom, @CreatedBy);
            `);
        return { status: 201, jsonBody: { success: true, price: mapPrice(result.recordset[0]) } };
    } catch (error) {
        if (error.number === 2627 || error.number === 2601) {
            return { status: 409, jsonBody: { error: 'A lunch price already exists for that start date.' } };
        }
        throw error;
    }
}

function mapPrice(row) {
    return {
        externalLunchPriceId: row.ExternalLunchPriceID,
        priceCents: Number(row.PriceCents),
        validFrom: formatDate(row.ValidFrom),
        createdAt: row.CreatedAt,
        createdBy: row.CreatedBy
    };
}
function formatDate(value) { return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10); }
function bad(error) { return { status: 400, jsonBody: { error } }; }
