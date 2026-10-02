const { app } = require('@azure/functions');
const sql = require('mssql');

app.http('kiosk-products', {
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    authLevel: 'anonymous',
    route: 'kiosk/products/{id?}',
    handler: async (request, context) => {
        try {
            const pool = await sql.connect(process.env.SqlConnectionString);
            const rawId = request.params.id;
            const id = parseId(rawId);

            if (rawId && !id) {
                return response(400, { error: 'Invalid product ID.' });
            }

            switch (request.method.toUpperCase()) {
                case 'GET':
                    return await getProducts(pool, request, id);

                case 'POST':
                    if (id) {
                        return response(400, { error: 'Do not include a product ID when creating a product.' });
                    }
                    return await createProduct(pool, request);

                case 'PUT':
                    if (!id) {
                        return response(400, { error: 'Product ID is required.' });
                    }
                    return await updateProduct(pool, request, id);

                case 'DELETE':
                    if (!id) {
                        return response(400, { error: 'Product ID is required.' });
                    }
                    return await deactivateProduct(pool, id);

                default:
                    return response(405, { error: 'Method not allowed.' });
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
                SELECT
                    ProductID,
                    NameEN,
                    NameSV,
                    NameFI,
                    Price,
                    Icon,
                    ImageUrl,
                    Active,
                    CreatedAt,
                    UpdatedAt
                FROM dbo.KioskProducts
                WHERE ProductID = @ProductID;
            `);

        if (!result.recordset.length) {
            return response(404, { error: 'Product not found.' });
        }

        return response(200, mapProduct(result.recordset[0]));
    }

    const includeInactive = parseBoolean(
        request.query.get('includeInactive'),
        false
    );

    const result = await pool.request()
        .input('IncludeInactive', sql.Bit, includeInactive)
        .query(`
            SELECT
                ProductID,
                NameEN,
                NameSV,
                NameFI,
                Price,
                Icon,
                ImageUrl,
                Active,
                CreatedAt,
                UpdatedAt
            FROM dbo.KioskProducts
            WHERE @IncludeInactive = 1 OR Active = 1
            ORDER BY NameEN, ProductID;
        `);

    return response(200, result.recordset.map(mapProduct));
}

async function createProduct(pool, request) {
    const body = await readJson(request);
    const validation = validateProduct(body);

    if (validation.error) {
        return response(400, { error: validation.error });
    }

    const result = await productRequest(pool.request(), validation.value)
        .query(`
            INSERT INTO dbo.KioskProducts
            (
                NameEN,
                NameSV,
                NameFI,
                Price,
                Icon,
                ImageUrl,
                Active
            )
            OUTPUT
                inserted.ProductID,
                inserted.NameEN,
                inserted.NameSV,
                inserted.NameFI,
                inserted.Price,
                inserted.Icon,
                inserted.ImageUrl,
                inserted.Active,
                inserted.CreatedAt,
                inserted.UpdatedAt
            VALUES
            (
                @NameEN,
                @NameSV,
                @NameFI,
                @Price,
                @Icon,
                @ImageUrl,
                @Active
            );
        `);

    return response(201, mapProduct(result.recordset[0]));
}

async function updateProduct(pool, request, id) {
    const body = await readJson(request);
    const validation = validateProduct(body);

    if (validation.error) {
        return response(400, { error: validation.error });
    }

    const result = await productRequest(
        pool.request().input('ProductID', sql.Int, id),
        validation.value
    ).query(`
        UPDATE dbo.KioskProducts
        SET
            NameEN = @NameEN,
            NameSV = @NameSV,
            NameFI = @NameFI,
            Price = @Price,
            Icon = @Icon,
            ImageUrl = @ImageUrl,
            Active = @Active,
            UpdatedAt = SYSUTCDATETIME()
        OUTPUT
            inserted.ProductID,
            inserted.NameEN,
            inserted.NameSV,
            inserted.NameFI,
            inserted.Price,
            inserted.Icon,
            inserted.ImageUrl,
            inserted.Active,
            inserted.CreatedAt,
            inserted.UpdatedAt
        WHERE ProductID = @ProductID;
    `);

    if (!result.recordset.length) {
        return response(404, { error: 'Product not found.' });
    }

    return response(200, mapProduct(result.recordset[0]));
}

async function deactivateProduct(pool, id) {
    const result = await pool.request()
        .input('ProductID', sql.Int, id)
        .query(`
            UPDATE dbo.KioskProducts
            SET
                Active = 0,
                UpdatedAt = SYSUTCDATETIME()
            OUTPUT
                inserted.ProductID,
                inserted.NameEN,
                inserted.NameSV,
                inserted.NameFI,
                inserted.Price,
                inserted.Icon,
                inserted.ImageUrl,
                inserted.Active,
                inserted.CreatedAt,
                inserted.UpdatedAt
            WHERE ProductID = @ProductID;
        `);

    if (!result.recordset.length) {
        return response(404, { error: 'Product not found.' });
    }

    return response(200, mapProduct(result.recordset[0]));
}

function validateProduct(body) {
    const nameEn = text(body.nameEn, 255);
    const nameSv = nullableText(body.nameSv, 255);
    const nameFi = nullableText(body.nameFi, 255);
    const price = parsePrice(body.price);

    if (!nameEn) {
        return { error: 'nameEn is required.' };
    }

    if (price === null) {
        return {
            error: 'price is required and must be a non-negative number with no more than two decimal places.'
        };
    }

    return {
        value: {
            nameEn,
            nameSv,
            nameFi,
            price,
            icon: nullableText(body.icon, 100),
            imageUrl: nullableText(body.imageUrl, 500),
            active: parseBoolean(
                body.active !== undefined ? body.active : body.isActive,
                true
            )
        }
    };
}

function productRequest(request, value) {
    return request
        .input('NameEN', sql.NVarChar(255), value.nameEn)
        .input('NameSV', sql.NVarChar(255), value.nameSv)
        .input('NameFI', sql.NVarChar(255), value.nameFi)
        .input('Price', sql.Decimal(10, 2), value.price)
        .input('Icon', sql.NVarChar(100), value.icon)
        .input('ImageUrl', sql.NVarChar(500), value.imageUrl)
        .input('Active', sql.Bit, value.active);
}

function mapProduct(row) {
    return {
        productId: row.ProductID,
        nameEn: row.NameEN,
        nameSv: row.NameSV,
        nameFi: row.NameFI,
        price: Number(row.Price),
        icon: row.Icon,
        imageUrl: row.ImageUrl,
        active: Boolean(row.Active),
        isActive: Boolean(row.Active),
        createdAt: row.CreatedAt,
        updatedAt: row.UpdatedAt
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
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
}

function parsePrice(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    const number = Number(value);

    if (!Number.isFinite(number) || number < 0) {
        return null;
    }

    const rounded = Math.round((number + Number.EPSILON) * 100) / 100;

    if (Math.abs(number - rounded) > 0.0000001 || rounded > 99999999.99) {
        return null;
    }

    return rounded;
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

function parseBoolean(value, fallback) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }

    if (typeof value === 'boolean') {
        return value;
    }

    if (value === 1 || String(value).toLowerCase() === 'true' || String(value) === '1') {
        return true;
    }

    if (value === 0 || String(value).toLowerCase() === 'false' || String(value) === '0') {
        return false;
    }

    return fallback;
}

function response(status, jsonBody) {
    return { status, jsonBody };
}

function databaseError(error, message) {
    if (error.number === 2601 || error.number === 2627) {
        return response(409, {
            error: 'A conflicting record already exists.',
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
