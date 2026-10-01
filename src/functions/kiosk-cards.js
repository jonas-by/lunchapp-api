const { app } = require('@azure/functions');
const sql = require('mssql');

app.http('kiosk-cards', {
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    authLevel: 'anonymous',
    route: 'kiosk/cards/{id?}',
    handler: async (request, context) => {
        try {
            const pool = await sql.connect(process.env.SqlConnectionString);
            const id = parseId(request.params.id);
            if (request.params.id && !id) return response(400, { error: 'Invalid card ID.' });

            switch (request.method.toUpperCase()) {
                case 'GET': return await getCards(pool, request, id);
                case 'POST': return await createCard(pool, request);
                case 'PUT':
                    if (!id) return response(400, { error: 'Card ID is required.' });
                    return await updateCard(pool, request, id);
                case 'DELETE':
                    if (!id) return response(400, { error: 'Card ID is required.' });
                    return await deactivateCard(pool, id);
                default: return response(405, { error: 'Method not allowed.' });
            }
        } catch (error) {
            context.error('Kiosk cards request failed', error);
            return databaseError(error, 'Kiosk cards request failed.');
        }
    }
});

async function getCards(pool, request, id) {
    const includeInactive = parseBoolean(request.query.get('includeInactive'), false);
    const dbRequest = pool.request()
        .input('IncludeInactive', sql.Bit, includeInactive)
        .input('CardID', sql.Int, id);

    const result = await dbRequest.query(`
        SELECT
            c.CardID, c.CardNumber, c.OwnerType, c.EmployeeNo,
            c.ExternalAccountID, c.DisplayNameOverride, c.IsActive,
            c.ValidFrom, c.ValidUntil, c.CreatedAt, c.UpdatedAt,
            e.FirstName, e.LastName,
            a.DisplayName AS ExternalDisplayName,
            a.CompanyName, a.AccountMode, a.IsActive AS AccountIsActive,
            COALESCE(b.BalanceCents, 0) AS BalanceCents
        FROM dbo.KioskCards c
        LEFT JOIN dbo.Employees e ON e.EmployeeNo = c.EmployeeNo
        LEFT JOIN dbo.ExternalAccounts a ON a.ExternalAccountID = c.ExternalAccountID
        LEFT JOIN dbo.vwExternalAccountBalances b ON b.ExternalAccountID = c.ExternalAccountID
        WHERE (@CardID IS NULL OR c.CardID = @CardID)
          AND (@IncludeInactive = 1 OR c.IsActive = 1)
        ORDER BY c.CardNumber, c.CardID;
    `);

    if (id) {
        if (!result.recordset.length) return response(404, { error: 'Card not found.' });
        return response(200, mapCard(result.recordset[0]));
    }
    return response(200, result.recordset.map(mapCard));
}

async function createCard(pool, request) {
    const body = await readJson(request);
    const value = validateCard(body);
    if (value.error) return response(400, { error: value.error });

    const ownerError = await validateOwner(pool, value);
    if (ownerError) return response(ownerError.status, { error: ownerError.error });

    const result = await cardRequest(pool.request(), value).query(`
        INSERT dbo.KioskCards
            (CardNumber, OwnerType, EmployeeNo, ExternalAccountID,
             DisplayNameOverride, IsActive, ValidFrom, ValidUntil)
        OUTPUT inserted.*
        VALUES
            (@CardNumber, @OwnerType, @EmployeeNo, @ExternalAccountID,
             @DisplayNameOverride, @IsActive, @ValidFrom, @ValidUntil);
    `);

    return response(201, mapBasicCard(result.recordset[0]));
}

async function updateCard(pool, request, id) {
    const body = await readJson(request);
    const value = validateCard(body);
    if (value.error) return response(400, { error: value.error });

    const ownerError = await validateOwner(pool, value);
    if (ownerError) return response(ownerError.status, { error: ownerError.error });

    const result = await cardRequest(
        pool.request().input('CardID', sql.Int, id), value
    ).query(`
        UPDATE dbo.KioskCards
        SET CardNumber = @CardNumber,
            OwnerType = @OwnerType,
            EmployeeNo = @EmployeeNo,
            ExternalAccountID = @ExternalAccountID,
            DisplayNameOverride = @DisplayNameOverride,
            IsActive = @IsActive,
            ValidFrom = @ValidFrom,
            ValidUntil = @ValidUntil,
            UpdatedAt = SYSUTCDATETIME()
        OUTPUT inserted.*
        WHERE CardID = @CardID;
    `);

    if (!result.recordset.length) return response(404, { error: 'Card not found.' });
    return response(200, mapBasicCard(result.recordset[0]));
}

async function deactivateCard(pool, id) {
    const result = await pool.request()
        .input('CardID', sql.Int, id)
        .query(`
            UPDATE dbo.KioskCards
            SET IsActive = 0, UpdatedAt = SYSUTCDATETIME()
            OUTPUT inserted.*
            WHERE CardID = @CardID;
        `);

    if (!result.recordset.length) return response(404, { error: 'Card not found.' });
    return response(200, mapBasicCard(result.recordset[0]));
}

async function validateOwner(pool, value) {
    if (value.ownerType === 'Employee') {
        const result = await pool.request()
            .input('EmployeeNo', sql.Int, value.employeeNo)
            .query('SELECT EmployeeNo FROM dbo.Employees WHERE EmployeeNo = @EmployeeNo;');
        return result.recordset.length ? null : { status: 400, error: 'Employee does not exist.' };
    }

    const result = await pool.request()
        .input('ExternalAccountID', sql.Int, value.externalAccountId)
        .query(`
            SELECT ExternalAccountID, IsActive
            FROM dbo.ExternalAccounts
            WHERE ExternalAccountID = @ExternalAccountID;
        `);
    if (!result.recordset.length) return { status: 400, error: 'External account does not exist.' };
    if (!result.recordset[0].IsActive && value.isActive) return { status: 400, error: 'An active card cannot be assigned to an inactive external account.' };
    return null;
}

function validateCard(body) {
    const cardNumber = text(body.cardNumber, 100);
    const type = String(body.ownerType || '').trim().toLowerCase();
    const ownerType = type === 'employee' ? 'Employee' : type === 'external' ? 'External' : null;
    const employeeNo = positiveInteger(body.employeeNo);
    const externalAccountId = positiveInteger(body.externalAccountId);
    const validFrom = nullableDateTime(body.validFrom);
    const validUntil = nullableDateTime(body.validUntil);

    if (!cardNumber) return { error: 'cardNumber is required.' };
    if (!ownerType) return { error: 'ownerType must be Employee or External.' };
    if (ownerType === 'Employee' && !employeeNo) return { error: 'employeeNo is required for an employee card.' };
    if (ownerType === 'External' && !externalAccountId) return { error: 'externalAccountId is required for an external card.' };
    if (body.validFrom && !validFrom) return { error: 'validFrom must be a valid ISO date/time.' };
    if (body.validUntil && !validUntil) return { error: 'validUntil must be a valid ISO date/time.' };
    if (validFrom && validUntil && validFrom > validUntil) return { error: 'validFrom cannot be later than validUntil.' };

    return {
        cardNumber,
        ownerType,
        employeeNo: ownerType === 'Employee' ? employeeNo : null,
        externalAccountId: ownerType === 'External' ? externalAccountId : null,
        displayNameOverride: nullableText(body.displayNameOverride, 150),
        isActive: parseBoolean(body.isActive, true),
        validFrom,
        validUntil
    };
}

function cardRequest(request, value) {
    return request
        .input('CardNumber', sql.NVarChar(100), value.cardNumber)
        .input('OwnerType', sql.NVarChar(20), value.ownerType)
        .input('EmployeeNo', sql.Int, value.employeeNo)
        .input('ExternalAccountID', sql.Int, value.externalAccountId)
        .input('DisplayNameOverride', sql.NVarChar(150), value.displayNameOverride)
        .input('IsActive', sql.Bit, value.isActive)
        .input('ValidFrom', sql.DateTime2, value.validFrom)
        .input('ValidUntil', sql.DateTime2, value.validUntil);
}

function mapCard(row) {
    const employeeName = [row.FirstName, row.LastName].filter(Boolean).join(' ');
    return {
        ...mapBasicCard(row),
        displayName: row.DisplayNameOverride || (row.OwnerType === 'Employee' ? employeeName : row.ExternalDisplayName),
        companyName: row.CompanyName || null,
        accountMode: row.AccountMode || null,
        accountIsActive: row.AccountIsActive === null || row.AccountIsActive === undefined ? null : Boolean(row.AccountIsActive),
        balanceCents: row.ExternalAccountID ? Number(row.BalanceCents || 0) : null
    };
}

function mapBasicCard(row) {
    return {
        cardId: row.CardID,
        cardNumber: row.CardNumber,
        ownerType: String(row.OwnerType).toLowerCase(),
        employeeNo: row.EmployeeNo,
        externalAccountId: row.ExternalAccountID,
        displayNameOverride: row.DisplayNameOverride,
        isActive: Boolean(row.IsActive),
        validFrom: row.ValidFrom,
        validUntil: row.ValidUntil,
        createdAt: row.CreatedAt,
        updatedAt: row.UpdatedAt
    };
}

async function readJson(request) { try { return await request.json(); } catch { return {}; } }
function parseId(value) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : null; }
function positiveInteger(value) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : null; }
function text(value, max) { return typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, max) : ''; }
function nullableText(value, max) { const v = text(value, max); return v || null; }
function nullableDateTime(value) { if (value === undefined || value === null || value === '') return null; const d = new Date(value); return Number.isNaN(d.getTime()) ? null : d; }
function parseBoolean(value, fallback) { if (value === undefined || value === null || value === '') return fallback; return value === true || value === 1 || String(value).toLowerCase() === 'true' || String(value) === '1'; }
function response(status, jsonBody) { return { status, jsonBody }; }
function databaseError(error, message) {
    if (error.number === 2601 || error.number === 2627) return response(409, { error: 'Card number already exists.', details: error.message });
    if (error.number === 547) return response(400, { error: 'The card owner is invalid.', details: error.message });
    return response(500, { error: message, details: error.message });
}
