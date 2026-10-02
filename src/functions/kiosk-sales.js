const { app } = require('@azure/functions');
const sql = require('mssql');

const MAX_DISTINCT_PRODUCTS = 100;
const MAX_QUANTITY_PER_PRODUCT = 100;

class HttpError extends Error {
    constructor(status, message, details) {
        super(message);
        this.status = status;
        this.details = details;
    }
}

app.http('kiosk-sales', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    route: 'kiosk/sales/{id?}',
    handler: async (request, context) => {
        try {
            const pool = await sql.connect(process.env.SqlConnectionString);
            const rawId = request.params.id;
            const saleId = parsePositiveInteger(rawId);

            if (rawId && !saleId) {
                return response(400, { error: 'Invalid sale ID.' });
            }

            if (request.method.toUpperCase() === 'GET') {
                if (!saleId) {
                    return response(400, { error: 'Sale ID is required.' });
                }
                return await getSale(pool, saleId);
            }

            if (request.method.toUpperCase() === 'POST') {
                if (saleId) {
                    return response(400, { error: 'Do not include a sale ID when creating a sale.' });
                }
                return await createSale(pool, request, context);
            }

            return response(405, { error: 'Method not allowed.' });
        } catch (error) {
            context.error('Kiosk sales request failed', error);
            return errorResponse(error);
        }
    }
});

async function createSale(pool, request, context) {
    const body = await readJson(request);
    const cardNumber = cleanText(body.cardNumber, 100);
    const createdBy = cleanText(body.createdBy, 100) || 'Kiosk';
    const items = normalizeItems(body.items);

    if (!cardNumber) {
        throw new HttpError(400, 'cardNumber is required.');
    }

    if (items.error) {
        throw new HttpError(400, items.error);
    }

    const transaction = new sql.Transaction(pool);

    try {
        await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

        const owner = await resolveOwner(transaction, cardNumber);
        const productRows = await loadProducts(transaction, items.value);
        const saleLines = buildSaleLines(items.value, productRows);
        const totalCents = sumSaleTotal(saleLines);

        if (totalCents > 2147483647) {
            throw new HttpError(400, 'Sale total is too large.');
        }

        let balanceBeforeCents = null;
        let balanceAfterCents = null;

        if (owner.ownerType === 'External') {
            const balance = await checkExternalAccountBalance(
                transaction,
                owner,
                totalCents
            );
            balanceBeforeCents = balance.before;
            balanceAfterCents = balance.after;
        }

        const sale = await insertSale(
            transaction,
            owner,
            totalCents,
            createdBy
        );

        await insertSaleLines(transaction, sale.saleId, saleLines);

        if (owner.ownerType === 'External') {
            await insertPurchaseLedgerEntry(
                transaction,
                owner.externalAccountId,
                sale.saleId,
                totalCents,
                createdBy
            );
        }

        await transaction.commit();

        return response(201, {
            saleId: sale.saleId,
            saleTime: sale.saleTime,
            status: 'Completed',
            ownerType: owner.ownerType.toLowerCase(),
            employeeNo: owner.employeeNo,
            externalAccountId: owner.externalAccountId,
            cardId: owner.cardId,
            displayName: owner.displayName,
            accountMode: owner.accountMode,
            totalCents,
            balanceBeforeCents,
            balanceAfterCents,
            items: saleLines.map(mapSaleLine)
        });
    } catch (error) {
        if (transaction._aborted !== true) {
            try {
                await transaction.rollback();
            } catch (rollbackError) {
                context.error('Kiosk sale rollback failed', rollbackError);
            }
        }
        throw error;
    }
}

async function resolveOwner(transaction, cardNumber) {
    const employeeResult = await new sql.Request(transaction)
        .input('CardNumber', sql.NVarChar(100), cardNumber)
        .query(`
            SELECT TOP (2)
                EmployeeNo,
                FirstName,
                LastName,
                CardNumber
            FROM dbo.Employees WITH (UPDLOCK, HOLDLOCK)
            WHERE CardNumber = @CardNumber;
        `);

    if (employeeResult.recordset.length > 1) {
        throw new HttpError(409, 'The employee card number is assigned to more than one employee.');
    }

    if (employeeResult.recordset.length === 1) {
        const employee = employeeResult.recordset[0];
        return {
            ownerType: 'Employee',
            employeeNo: Number(employee.EmployeeNo),
            externalAccountId: null,
            cardId: null,
            accountMode: null,
            displayName: [employee.FirstName, employee.LastName]
                .filter(Boolean)
                .join(' ') || `Employee ${employee.EmployeeNo}`
        };
    }

    const externalResult = await new sql.Request(transaction)
        .input('CardNumber', sql.NVarChar(100), cardNumber)
        .query(`
            SELECT TOP (2)
                c.CardID,
                c.CardNumber,
                c.CardHolderName,
                c.IsActive AS CardIsActive,
                c.ValidFrom AS CardValidFrom,
                c.ValidUntil AS CardValidUntil,
                a.ExternalAccountID,
                a.DisplayName,
                a.CompanyName,
                a.AccountMode,
                a.CreditLimitCents,
                a.IsActive AS AccountIsActive,
                a.ValidFrom AS AccountValidFrom,
                a.ValidUntil AS AccountValidUntil
            FROM dbo.KioskCards AS c WITH (UPDLOCK, HOLDLOCK)
            INNER JOIN dbo.ExternalAccounts AS a WITH (UPDLOCK, HOLDLOCK)
                ON a.ExternalAccountID = c.ExternalAccountID
            WHERE c.CardNumber = @CardNumber
              AND c.OwnerType = N'External';
        `);

    if (externalResult.recordset.length > 1) {
        throw new HttpError(409, 'The external card number is assigned more than once.');
    }

    if (!externalResult.recordset.length) {
        throw new HttpError(404, 'Card not found.');
    }

    const row = externalResult.recordset[0];
    validateExternalCardAndAccount(row);

    return {
        ownerType: 'External',
        employeeNo: null,
        externalAccountId: Number(row.ExternalAccountID),
        cardId: Number(row.CardID),
        accountMode: normalizeMode(row.AccountMode),
        creditLimitCents: row.CreditLimitCents === null
            ? null
            : Number(row.CreditLimitCents),
        displayName: row.CardHolderName || row.DisplayName,
        companyName: row.CompanyName
    };
}

function validateExternalCardAndAccount(row) {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    if (!row.CardIsActive) {
        throw new HttpError(403, 'Card is inactive.');
    }
    if (row.CardValidFrom && now < new Date(row.CardValidFrom)) {
        throw new HttpError(403, 'Card is not valid yet.');
    }
    if (row.CardValidUntil && now > new Date(row.CardValidUntil)) {
        throw new HttpError(403, 'Card has expired.');
    }
    if (!row.AccountIsActive) {
        throw new HttpError(403, 'External account is inactive.');
    }
    if (row.AccountValidFrom && today < dateOnly(row.AccountValidFrom)) {
        throw new HttpError(403, 'External account is not valid yet.');
    }
    if (row.AccountValidUntil && today > dateOnly(row.AccountValidUntil)) {
        throw new HttpError(403, 'External account has expired.');
    }

    const mode = normalizeMode(row.AccountMode);
    if (!mode) {
        throw new HttpError(409, 'External account has an unsupported account mode.');
    }
}

async function loadProducts(transaction, items) {
    const productIdsJson = JSON.stringify(items.map(item => item.productId));

    const result = await new sql.Request(transaction)
        .input('ProductIDs', sql.NVarChar(sql.MAX), productIdsJson)
        .query(`
            SELECT
                p.ProductID,
                p.NameEN,
                p.NameSV,
                p.NameFI,
                p.Price,
                p.Active
            FROM dbo.KioskProducts AS p WITH (HOLDLOCK)
            INNER JOIN OPENJSON(@ProductIDs)
                WITH (ProductID INT '$') AS requested
                ON requested.ProductID = p.ProductID;
        `);

    const byId = new Map(
        result.recordset.map(row => [Number(row.ProductID), row])
    );

    const missing = items
        .filter(item => !byId.has(item.productId))
        .map(item => item.productId);

    if (missing.length) {
        throw new HttpError(400, 'One or more products do not exist.', { productIds: missing });
    }

    const inactive = result.recordset
        .filter(row => !row.Active)
        .map(row => Number(row.ProductID));

    if (inactive.length) {
        throw new HttpError(409, 'One or more products are inactive.', { productIds: inactive });
    }

    return byId;
}

function buildSaleLines(items, productRows) {
    return items.map(item => {
        const product = productRows.get(item.productId);
        const unitPriceCents = decimalPriceToCents(product.Price);
        const lineTotalCents = unitPriceCents * item.quantity;

        if (!Number.isSafeInteger(lineTotalCents)) {
            throw new HttpError(400, `Line total for product ${item.productId} is too large.`);
        }

        return {
            productId: item.productId,
            productNameSnapshot: cleanText(
                product.NameSV || product.NameEN || product.NameFI,
                150
            ),
            unitPriceCents,
            quantity: item.quantity,
            lineTotalCents
        };
    });
}

function sumSaleTotal(lines) {
    const total = lines.reduce((sum, line) => sum + line.lineTotalCents, 0);
    if (!Number.isSafeInteger(total) || total < 0) {
        throw new HttpError(400, 'Sale total is invalid.');
    }
    return total;
}

async function checkExternalAccountBalance(transaction, owner, totalCents) {
    const result = await new sql.Request(transaction)
        .input('ExternalAccountID', sql.Int, owner.externalAccountId)
        .query(`
            SELECT
                COALESCE(SUM(CONVERT(BIGINT, AmountCents)), 0) AS BalanceCents
            FROM dbo.ExternalAccountLedger WITH (UPDLOCK, HOLDLOCK)
            WHERE ExternalAccountID = @ExternalAccountID;
        `);

    const before = Number(result.recordset[0].BalanceCents || 0);
    const after = before - totalCents;

    if (owner.accountMode === 'Prepaid' && after < 0) {
        throw new HttpError(409, 'Insufficient prepaid balance.', {
            balanceCents: before,
            requiredCents: totalCents,
            missingCents: Math.abs(after)
        });
    }

    if (owner.accountMode === 'Postpaid' || owner.accountMode === 'Invoice') {
        const outstandingAfter = Math.max(0, -after);
        if (
            owner.creditLimitCents !== null &&
            outstandingAfter > owner.creditLimitCents
        ) {
            throw new HttpError(409, 'Credit limit exceeded.', {
                balanceCents: before,
                purchaseCents: totalCents,
                outstandingAfterCents: outstandingAfter,
                creditLimitCents: owner.creditLimitCents
            });
        }
    }

    return { before, after };
}

async function insertSale(transaction, owner, totalCents, createdBy) {
    const result = await new sql.Request(transaction)
        .input('CardID', sql.Int, owner.cardId)
        .input('OwnerType', sql.NVarChar(20), owner.ownerType)
        .input('EmployeeNo', sql.Int, owner.employeeNo)
        .input('ExternalAccountID', sql.Int, owner.externalAccountId)
        .input('TotalCents', sql.Int, totalCents)
        .input('CreatedBy', sql.NVarChar(100), createdBy)
        .query(`
            INSERT INTO dbo.KioskSales
            (
                CardID,
                OwnerType,
                EmployeeNo,
                ExternalAccountID,
                TotalCents,
                Status,
                CreatedBy
            )
            OUTPUT
                inserted.SaleID,
                inserted.SaleTime
            VALUES
            (
                @CardID,
                @OwnerType,
                @EmployeeNo,
                @ExternalAccountID,
                @TotalCents,
                N'Completed',
                @CreatedBy
            );
        `);

    return {
        saleId: Number(result.recordset[0].SaleID),
        saleTime: result.recordset[0].SaleTime
    };
}

async function insertSaleLines(transaction, saleId, lines) {
    const request = new sql.Request(transaction)
        .input('SaleID', sql.BigInt, saleId)
        .input('LinesJson', sql.NVarChar(sql.MAX), JSON.stringify(lines));

    await request.query(`
        INSERT INTO dbo.KioskSaleLines
        (
            SaleID,
            ProductID,
            ProductNameSnapshot,
            UnitPriceCents,
            Quantity
        )
        SELECT
            @SaleID,
            ProductID,
            ProductNameSnapshot,
            UnitPriceCents,
            Quantity
        FROM OPENJSON(@LinesJson)
        WITH
        (
            ProductID INT '$.productId',
            ProductNameSnapshot NVARCHAR(150) '$.productNameSnapshot',
            UnitPriceCents INT '$.unitPriceCents',
            Quantity INT '$.quantity'
        );
    `);
}

async function insertPurchaseLedgerEntry(
    transaction,
    externalAccountId,
    saleId,
    totalCents,
    createdBy
) {
    await new sql.Request(transaction)
        .input('ExternalAccountID', sql.Int, externalAccountId)
        .input('SaleID', sql.BigInt, saleId)
        .input('AmountCents', sql.Int, -totalCents)
        .input('CreatedBy', sql.NVarChar(100), createdBy)
        .query(`
            INSERT INTO dbo.ExternalAccountLedger
            (
                ExternalAccountID,
                EntryType,
                AmountCents,
                SaleID,
                Description,
                CreatedBy
            )
            VALUES
            (
                @ExternalAccountID,
                N'Purchase',
                @AmountCents,
                @SaleID,
                N'Café Kiosk purchase',
                @CreatedBy
            );
        `);
}

async function getSale(pool, saleId) {
    const result = await pool.request()
        .input('SaleID', sql.BigInt, saleId)
        .query(`
            SELECT
                s.SaleID,
                s.CardID,
                s.OwnerType,
                s.EmployeeNo,
                s.ExternalAccountID,
                s.SaleTime,
                s.TotalCents,
                s.Status,
                s.CreatedBy,
                s.VoidedAt,
                s.VoidedBy,
                s.VoidReason,
                sl.SaleLineID,
                sl.ProductID,
                sl.ProductNameSnapshot,
                sl.UnitPriceCents,
                sl.Quantity,
                sl.LineTotalCents
            FROM dbo.KioskSales AS s
            LEFT JOIN dbo.KioskSaleLines AS sl
                ON sl.SaleID = s.SaleID
            WHERE s.SaleID = @SaleID
            ORDER BY sl.SaleLineID;
        `);

    if (!result.recordset.length) {
        return response(404, { error: 'Sale not found.' });
    }

    const first = result.recordset[0];
    return response(200, {
        saleId: Number(first.SaleID),
        cardId: first.CardID === null ? null : Number(first.CardID),
        ownerType: String(first.OwnerType).toLowerCase(),
        employeeNo: first.EmployeeNo === null ? null : Number(first.EmployeeNo),
        externalAccountId: first.ExternalAccountID === null
            ? null
            : Number(first.ExternalAccountID),
        saleTime: first.SaleTime,
        totalCents: Number(first.TotalCents),
        status: first.Status,
        createdBy: first.CreatedBy,
        voidedAt: first.VoidedAt,
        voidedBy: first.VoidedBy,
        voidReason: first.VoidReason,
        items: result.recordset
            .filter(row => row.SaleLineID !== null)
            .map(row => ({
                saleLineId: Number(row.SaleLineID),
                productId: Number(row.ProductID),
                productName: row.ProductNameSnapshot,
                unitPriceCents: Number(row.UnitPriceCents),
                quantity: Number(row.Quantity),
                lineTotalCents: Number(row.LineTotalCents)
            }))
    });
}

function normalizeItems(items) {
    if (!Array.isArray(items) || items.length === 0) {
        return { error: 'items must be a non-empty array.' };
    }

    const quantities = new Map();

    for (const item of items) {
        const productId = parsePositiveInteger(item && item.productId);
        const quantity = parsePositiveInteger(item && item.quantity);

        if (!productId) {
            return { error: 'Each item must contain a positive integer productId.' };
        }
        if (!quantity || quantity > MAX_QUANTITY_PER_PRODUCT) {
            return {
                error: `Each item quantity must be between 1 and ${MAX_QUANTITY_PER_PRODUCT}.`
            };
        }

        const combined = (quantities.get(productId) || 0) + quantity;
        if (combined > MAX_QUANTITY_PER_PRODUCT) {
            return {
                error: `Combined quantity for product ${productId} exceeds ${MAX_QUANTITY_PER_PRODUCT}.`
            };
        }
        quantities.set(productId, combined);
    }

    if (quantities.size > MAX_DISTINCT_PRODUCTS) {
        return {
            error: `A sale may contain at most ${MAX_DISTINCT_PRODUCTS} distinct products.`
        };
    }

    return {
        value: Array.from(quantities, ([productId, quantity]) => ({
            productId,
            quantity
        }))
    };
}

function decimalPriceToCents(value) {
    const number = Number(value);
    const cents = Math.round((number + Number.EPSILON) * 100);

    if (!Number.isFinite(number) || number < 0 || !Number.isSafeInteger(cents)) {
        throw new HttpError(409, 'A product has an invalid price.');
    }

    return cents;
}

function normalizeMode(value) {
    const mode = cleanText(value, 20).toLowerCase();
    if (mode === 'prepaid') return 'Prepaid';
    if (mode === 'postpaid') return 'Postpaid';
    if (mode === 'invoice') return 'Invoice';
    return null;
}

function mapSaleLine(line) {
    return {
        productId: line.productId,
        productName: line.productNameSnapshot,
        unitPriceCents: line.unitPriceCents,
        quantity: line.quantity,
        lineTotalCents: line.lineTotalCents
    };
}

async function readJson(request) {
    try {
        return await request.json();
    } catch {
        throw new HttpError(400, 'Request body must contain valid JSON.');
    }
}

function parsePositiveInteger(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function cleanText(value, maxLength) {
    if (value === undefined || value === null) return '';
    return String(value).trim().slice(0, maxLength);
}

function dateOnly(value) {
    return typeof value === 'string'
        ? value.slice(0, 10)
        : value.toISOString().slice(0, 10);
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
        return response(409, {
            error: 'A conflicting record already exists.',
            details: error.message
        });
    }

    if (error.number === 547) {
        return response(409, {
            error: 'The sale conflicts with a database constraint.',
            details: error.message
        });
    }

    return response(500, {
        error: 'Kiosk sales request failed.',
        details: error.message
    });
}
