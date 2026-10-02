const { app } = require('@azure/functions');
const sql = require('mssql');

class HttpError extends Error {
    constructor(status, message, details) {
        super(message);
        this.status = status;
        this.details = details;
    }
}

app.http('kiosk-layouts', {
    methods: ['GET', 'PUT'],
    authLevel: 'anonymous',
    route: 'kiosk/layouts/{id?}',
    handler: async (request, context) => {
        try {
            const pool = await sql.connect(process.env.SqlConnectionString);
            const rawId = request.params.id;

            if (request.method.toUpperCase() === 'GET') {
                if (!rawId) return await listLayouts(pool);
                if (String(rawId).toLowerCase() === 'default') return await getDefaultLayout(pool);

                const layoutId = positiveInteger(rawId);
                if (!layoutId) return response(400, { error: 'Invalid layout ID.' });
                return await getLayout(pool, layoutId);
            }

            if (request.method.toUpperCase() === 'PUT') {
                const layoutId = positiveInteger(rawId);
                if (!layoutId) return response(400, { error: 'Layout ID is required.' });
                return await replaceLayoutItems(pool, request, layoutId, context);
            }

            return response(405, { error: 'Method not allowed.' });
        } catch (error) {
            context.error('Kiosk layouts request failed', error);
            return errorResponse(error);
        }
    }
});

async function listLayouts(pool) {
    const result = await pool.request().query(`
        SELECT
            l.LayoutID,
            l.LayoutName,
            l.IsActive,
            l.IsDefault,
            l.CreatedAt,
            l.UpdatedAt,
            COUNT(li.LayoutItemID) AS ItemCount
        FROM dbo.KioskLayouts AS l
        LEFT JOIN dbo.KioskLayoutItems AS li
            ON li.LayoutID = l.LayoutID
        GROUP BY
            l.LayoutID,
            l.LayoutName,
            l.IsActive,
            l.IsDefault,
            l.CreatedAt,
            l.UpdatedAt
        ORDER BY l.IsDefault DESC, l.LayoutName, l.LayoutID;
    `);

    return response(200, result.recordset.map(row => ({
        layoutId: Number(row.LayoutID),
        layoutName: row.LayoutName,
        isActive: Boolean(row.IsActive),
        isDefault: Boolean(row.IsDefault),
        itemCount: Number(row.ItemCount || 0),
        createdAt: row.CreatedAt,
        updatedAt: row.UpdatedAt
    })));
}

async function getDefaultLayout(pool) {
    const result = await pool.request().query(`
        SELECT TOP (1) LayoutID
        FROM dbo.KioskLayouts
        WHERE IsDefault = 1 AND IsActive = 1
        ORDER BY LayoutID;
    `);

    if (!result.recordset.length) {
        return response(404, { error: 'No active default kiosk layout exists.' });
    }

    return await getLayout(pool, Number(result.recordset[0].LayoutID));
}

async function getLayout(pool, layoutId) {
    const layoutResult = await pool.request()
        .input('LayoutID', sql.Int, layoutId)
        .query(`
            SELECT
                LayoutID,
                LayoutName,
                IsActive,
                IsDefault,
                CreatedAt,
                UpdatedAt
            FROM dbo.KioskLayouts
            WHERE LayoutID = @LayoutID;
        `);

    if (!layoutResult.recordset.length) {
        return response(404, { error: 'Layout not found.' });
    }

    const itemResult = await pool.request()
        .input('LayoutID', sql.Int, layoutId)
        .query(`
            SELECT
                li.LayoutItemID,
                li.ProductID,
                li.ColumnNo,
                li.RowNo,
                li.IsVisible,
                p.NameEN,
                p.NameSV,
                p.NameFI,
                p.Price,
                p.Icon,
                p.ImageUrl,
                p.Active
            FROM dbo.KioskLayoutItems AS li
            INNER JOIN dbo.KioskProducts AS p
                ON p.ProductID = li.ProductID
            WHERE li.LayoutID = @LayoutID
            ORDER BY li.ColumnNo, li.RowNo, li.LayoutItemID;
        `);

    const layout = layoutResult.recordset[0];
    return response(200, {
        layoutId: Number(layout.LayoutID),
        layoutName: layout.LayoutName,
        isActive: Boolean(layout.IsActive),
        isDefault: Boolean(layout.IsDefault),
        createdAt: layout.CreatedAt,
        updatedAt: layout.UpdatedAt,
        items: itemResult.recordset.map(row => ({
            layoutItemId: Number(row.LayoutItemID),
            productId: Number(row.ProductID),
            columnNo: Number(row.ColumnNo),
            rowNo: Number(row.RowNo),
            isVisible: Boolean(row.IsVisible),
            product: {
                productId: Number(row.ProductID),
                nameEn: row.NameEN,
                nameSv: row.NameSV,
                nameFi: row.NameFI,
                price: Number(row.Price),
                icon: row.Icon,
                imageUrl: row.ImageUrl,
                active: Boolean(row.Active)
            }
        }))
    });
}

async function replaceLayoutItems(pool, request, layoutId, context) {
    const body = await readJson(request);
    const normalized = normalizeItems(body.items);
    if (normalized.error) throw new HttpError(400, normalized.error);

    const transaction = new sql.Transaction(pool);

    try {
        await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

        const layoutResult = await new sql.Request(transaction)
            .input('LayoutID', sql.Int, layoutId)
            .query(`
                SELECT LayoutID, LayoutName, IsActive, IsDefault
                FROM dbo.KioskLayouts WITH (UPDLOCK, HOLDLOCK)
                WHERE LayoutID = @LayoutID;
            `);

        if (!layoutResult.recordset.length) {
            throw new HttpError(404, 'Layout not found.');
        }

        if (normalized.value.length) {
            const productIds = JSON.stringify(normalized.value.map(item => item.productId));
            const productResult = await new sql.Request(transaction)
                .input('ProductIDs', sql.NVarChar(sql.MAX), productIds)
                .query(`
                    SELECT p.ProductID, p.Active
                    FROM dbo.KioskProducts AS p WITH (HOLDLOCK)
                    INNER JOIN OPENJSON(@ProductIDs)
                        WITH (ProductID INT '$') AS requested
                        ON requested.ProductID = p.ProductID;
                `);

            const products = new Map(productResult.recordset.map(row => [Number(row.ProductID), Boolean(row.Active)]));
            const missing = normalized.value.filter(item => !products.has(item.productId)).map(item => item.productId);
            const inactive = normalized.value.filter(item => products.has(item.productId) && !products.get(item.productId)).map(item => item.productId);

            if (missing.length) throw new HttpError(400, 'One or more products do not exist.', { productIds: missing });
            if (inactive.length) throw new HttpError(409, 'Inactive products cannot be added to a layout.', { productIds: inactive });
        }

        await new sql.Request(transaction)
            .input('LayoutID', sql.Int, layoutId)
            .query('DELETE FROM dbo.KioskLayoutItems WHERE LayoutID = @LayoutID;');

        if (normalized.value.length) {
            await new sql.Request(transaction)
                .input('LayoutID', sql.Int, layoutId)
                .input('ItemsJson', sql.NVarChar(sql.MAX), JSON.stringify(normalized.value))
                .query(`
                    INSERT INTO dbo.KioskLayoutItems
                    (
                        LayoutID,
                        ProductID,
                        ColumnNo,
                        RowNo,
                        IsVisible
                    )
                    SELECT
                        @LayoutID,
                        ProductID,
                        ColumnNo,
                        RowNo,
                        IsVisible
                    FROM OPENJSON(@ItemsJson)
                    WITH
                    (
                        ProductID INT '$.productId',
                        ColumnNo TINYINT '$.columnNo',
                        RowNo SMALLINT '$.rowNo',
                        IsVisible BIT '$.isVisible'
                    );
                `);
        }

        await new sql.Request(transaction)
            .input('LayoutID', sql.Int, layoutId)
            .query(`
                UPDATE dbo.KioskLayouts
                SET UpdatedAt = SYSUTCDATETIME()
                WHERE LayoutID = @LayoutID;
            `);

        await transaction.commit();
        return await getLayout(pool, layoutId);
    } catch (error) {
        if (transaction._aborted !== true) {
            try { await transaction.rollback(); }
            catch (rollbackError) { context.error('Kiosk layout rollback failed', rollbackError); }
        }
        throw error;
    }
}

function normalizeItems(items) {
    if (!Array.isArray(items)) return { error: 'items must be an array.' };
    if (items.length > 500) return { error: 'A layout may contain at most 500 products.' };

    const productIds = new Set();
    const positions = new Set();
    const rowsByColumn = { 1: [], 2: [] };

    for (const item of items) {
        const productId = positiveInteger(item && item.productId);
        const columnNo = positiveInteger(item && item.columnNo);
        const rowNo = positiveInteger(item && item.rowNo);

        if (!productId) return { error: 'Every item requires a positive integer productId.' };
        if (columnNo !== 1 && columnNo !== 2) return { error: 'columnNo must be 1 or 2.' };
        if (!rowNo || rowNo > 32767) return { error: 'rowNo must be between 1 and 32767.' };
        if (productIds.has(productId)) return { error: `Product ${productId} appears more than once.` };

        const position = `${columnNo}:${rowNo}`;
        if (positions.has(position)) return { error: `Position column ${columnNo}, row ${rowNo} is used more than once.` };

        productIds.add(productId);
        positions.add(position);
        rowsByColumn[columnNo].push(rowNo);
    }

    for (const columnNo of [1, 2]) {
        const sorted = rowsByColumn[columnNo].sort((a, b) => a - b);
        for (let index = 0; index < sorted.length; index += 1) {
            if (sorted[index] !== index + 1) {
                return { error: `Rows in column ${columnNo} must be consecutive starting at 1.` };
            }
        }
    }

    return {
        value: items
            .map(item => ({
                productId: Number(item.productId),
                columnNo: Number(item.columnNo),
                rowNo: Number(item.rowNo),
                isVisible: item.isVisible !== false
            }))
            .sort((a, b) => a.columnNo - b.columnNo || a.rowNo - b.rowNo)
    };
}

async function readJson(request) {
    try { return await request.json(); }
    catch { throw new HttpError(400, 'Request body must contain valid JSON.'); }
}

function positiveInteger(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function response(status, jsonBody) {
    return { status, jsonBody };
}

function errorResponse(error) {
    if (error instanceof HttpError) {
        return response(error.status, {
            error: error.message,
            ...(error.details ? { details: error.details } : {})
        });
    }

    if (error.number === 2601 || error.number === 2627) {
        return response(409, { error: 'The layout contains a duplicate product or position.', details: error.message });
    }

    if (error.number === 547) {
        return response(409, { error: 'The layout conflicts with a database constraint.', details: error.message });
    }

    return response(500, { error: 'Kiosk layouts request failed.', details: error.message });
}
