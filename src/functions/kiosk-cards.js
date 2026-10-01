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

            if (request.params.id && !id) {
                return response(400, { error: 'Invalid card ID.' });
            }

            switch (request.method.toUpperCase()) {
                case 'GET':
                    return await getCards(pool, request, id);
                case 'POST':
                    return await createCard(pool, request);
                case 'PUT':
                    if (!id) return response(400, { error: 'Card ID is required.' });
                    return await updateCard(pool, request, id);
                case 'DELETE':
                    if (!id) return response(400, { error: 'Card ID is required.' });
                    return await deactivateCard(pool, id);
                default:
                    return response(405, { error: 'Method not allowed.' });
            }
        } catch (error) {
            context.error('Kiosk external cards request failed', error);
            return databaseError(error);
        }
    }
});

async function getCards(pool, request, id) {
    const includeInactive = parseBoolean(
        request.query.get('includeInactive'),
        false
    );

    const result = await pool.request()
        .input('CardID', sql.Int, id)
        .input('IncludeInactive', sql.Bit, includeInactive)
        .query(`
            SELECT
                c.CardID,
                c.CardNumber,
                c.ExternalAccountID,
                c.DisplayNameOverride,
                c.IsActive,
                c.ValidFrom,
                c.ValidUntil,
                c.CreatedAt,
                c.UpdatedAt,
                a.DisplayName,
                a.CompanyName,
                a.AccountMode,
                a.IsActive AS AccountIsActive,
                COALESCE(b.BalanceCents, 0) AS BalanceCents
            FROM dbo.KioskCards c
            INNER JOIN dbo.ExternalAccounts a
                ON a.ExternalAccountID = c.ExternalAccountID
            LEFT JOIN dbo.vwExternalAccountBalances b
                ON b.ExternalAccountID = c.ExternalAccountID
            WHERE c.OwnerType = N'External'
              AND (@CardID IS NULL OR c.CardID = @CardID)
              AND (@IncludeInactive = 1 OR c.IsActive = 1)
            ORDER BY c.CardNumber, c.CardID;
        `);

    if (id) {
        if (!result.recordset.length) {
            return response(404, { error: 'External card not found.' });
        }
        return response(200, mapCard(result.recordset[0]));
    }

    return response(200, result.recordset.map(mapCard));
}

async function createCard(pool, request) {
    const body = await readJson(request);
    const value = validateCard(body);
    if (value.error) return response(400, { error: value.error });

    const conflict = await findEmployeeCardConflict(pool, value.cardNumber);
    if (conflict) {
        return response(409, {
            error: 'This card number is already assigned to an employee.',
            employeeNo: conflict.EmployeeNo
        });
    }

    const accountError = await validateExternalAccount(pool, value);
    if (accountError) return response(accountError.status, { error: accountError.error });

    const result = await cardRequest(pool.request(), value).query(`
        INSERT dbo.KioskCards
        (
            CardNumber,
            OwnerType,
            EmployeeNo,
            ExternalAccountID,
            DisplayNameOverride,
            IsActive,
            ValidFrom,
            ValidUntil
        )
        OUTPUT inserted.*
        VALUES
        (
            @CardNumber,
            N'External',
            NULL,
            @ExternalAccountID,
            @DisplayNameOverride,
            @IsActive,
            @ValidFrom,
            @ValidUntil
        );
    `);

    return response(201, mapInsertedCard(result.recordset[0]));
}

async function updateCard(pool, request, id) {
    const body = await readJson(request);
    const value = validateCard(body);
    if (value.error) return response(400, { error: value.error });

    const conflict = await findEmployeeCardConflict(pool, value.cardNumber);
    if (conflict) {
        return response(409, {
            error: 'This card number is already assigned to an employee.',
            employeeNo: conflict.EmployeeNo
        });
    }

    const accountError = await validateExternalAccount(pool, value);
    if (accountError) return response(accountError.status, { error: accountError.error });

    const result = await cardRequest(
        pool.request().input('CardID', sql.Int, id),
        value
    ).query(`
        UPDATE dbo.KioskCards
        SET CardNumber = @CardNumber,
            OwnerType = N'External',
            EmployeeNo = NULL,
            ExternalAccountID = @ExternalAccountID,
            DisplayNameOverride = @DisplayNameOverride,
            IsActive = @IsActive,
            ValidFrom = @ValidFrom,
            ValidUntil = @ValidUntil,
            UpdatedAt = SYSUTCDATETIME()
        OUTPUT inserted.*
        WHERE CardID = @CardID
          AND OwnerType = N'External';
    `);

    if (!result.recordset.length) {
        return response(404, { error: 'External card not found.' });
    }

    return response(200, mapInsertedCard(result.recordset[0]));
}

async function deactivateCard(pool, id) {
    const result = await pool.request()
        .input('CardID', sql.Int, id)
        .query(`
            UPDATE dbo.KioskCards
            SET IsActive = 0,
                UpdatedAt = SYSUTCDATETIME()
            OUTPUT inserted.*
            WHERE CardID = @CardID
              AND OwnerType = N'External';
        `);

    if (!result.recordset.length) {
        return response(404, { error: 'External card not found.' });
    }

    return response(200, mapInsertedCard(result.recordset[0]));
}

async function findEmployeeCardConflict(pool, cardNumber) {
    const result = await pool.request()
        .input('CardNumber', sql.NVarChar(100), cardNumber)
        .query(`
            SELECT TOP (1) EmployeeNo
            FROM dbo.Employees
            WHERE CardNumber = @CardNumber;
        `);

    return result.recordset[0] || null;
}

async function validateExternalAccount(pool, value) {
    const result = await pool.request()
        .input('ExternalAccountID', sql.Int, value.externalAccountId)
        .query(`
            SELECT ExternalAccountID, IsActive, ValidFrom, ValidUntil
            FROM dbo.ExternalAccounts
            WHERE ExternalAccountID = @ExternalAccountID;
        `);

    if (!result.recordset.length) {
        return { status: 400, error: 'External account does not exist.' };
    }

    const account = result.recordset[0];
    if (value.isActive && !account.IsActive) {
        return {
            status: 409,
            error: 'An active card cannot be assigned to an inactive external account.'
        };
    }

    return null;
}

function validateCard(body) {
    const cardNumber = cleanCardNumber(body.cardNumber);
    const externalAccountId = positiveInteger(body.externalAccountId);
    const validFrom = nullableDateTime(body.validFrom);
    const validUntil = nullableDateTime(body.validUntil);

    if (!cardNumber) return { error: 'cardNumber is required.' };
    if (!externalAccountId) {
        return { error: 'externalAccountId is required.' };
    }
    if (body.validFrom && !validFrom) {
        return { error: 'validFrom must be a valid ISO date/time.' };
    }
    if (body.validUntil && !validUntil) {
        return { error: 'validUntil must be a valid ISO date/time.' };
    }
    if (validFrom && validUntil && validFrom > validUntil) {
        return { error: 'validFrom cannot be later than validUntil.' };
    }

    return {
        cardNumber,
        externalAccountId,
        displayNameOverride: nullableText(body.displayNameOverride, 150),
        isActive: parseBoolean(body.isActive, true),
        validFrom,
        validUntil
    };
}

function cardRequest(request, value) {
    return request
        .input('CardNumber', sql.NVarChar(100), value.cardNumber)
        .input('ExternalAccountID', sql.Int, value.externalAccountId)
        .input('DisplayNameOverride', sql.NVarChar(150), value.displayNameOverride)
        .input('IsActive', sql.Bit, value.isActive)
        .input('ValidFrom', sql.DateTime2, value.validFrom)
        .input('ValidUntil', sql.DateTime2, value.validUntil);
}

function mapCard(row) {
    return {
        cardId: row.CardID,
        cardNumber: row.CardNumber,
        ownerType: 'external',
        externalAccountId: row.ExternalAccountID,
        displayNameOverride: row.DisplayNameOverride,
        displayName: row.DisplayNameOverride || row.DisplayName,
        companyName: row.CompanyName,
        accountMode: row.AccountMode,
        accountIsActive: Boolean(row.AccountIsActive),
        balanceCents: Number(row.BalanceCents || 0),
        isActive: Boolean(row.IsActive),
        validFrom: row.ValidFrom,
        validUntil: row.ValidUntil,
        createdAt: row.CreatedAt,
        updatedAt: row.UpdatedAt
    };
}

function mapInsertedCard(row) {
    return {
        cardId: row.CardID,
        cardNumber: row.CardNumber,
        ownerType: 'external',
        externalAccountId: row.ExternalAccountID,
        displayNameOverride: row.DisplayNameOverride,
        isActive: Boolean(row.IsActive),
        validFrom: row.ValidFrom,
        validUntil: row.ValidUntil,
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
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function positiveInteger(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function cleanCardNumber(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim().slice(0, 100);
}

function nullableText(value, maxLength) {
    if (typeof value !== 'string') return null;
    const result = value.trim().slice(0, maxLength);
    return result || null;
}

function nullableDateTime(value) {
    if (value === undefined || value === null || value === '') return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function parseBoolean(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return String(value).toLowerCase() === 'true' || String(value) === '1';
}

function response(status, jsonBody) {
    return { status, jsonBody };
}

function databaseError(error) {
    if (error.number === 2601 || error.number === 2627) {
        return response(409, {
            error: 'External card number already exists.',
            details: error.message
        });
    }
    if (error.number === 547) {
        return response(400, {
            error: 'The external account is invalid.',
            details: error.message
        });
    }
    return response(500, {
        error: 'Kiosk external cards request failed.',
        details: error.message
    });
}
