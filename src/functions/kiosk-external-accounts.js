const { app } = require('@azure/functions');
const sql = require('mssql');

const ACCOUNT_MODES = new Set(['Prepaid', 'Postpaid', 'Invoice']);
const ADJUSTMENT_TYPES = new Set(['Credit', 'Adjustment']);

app.http('kiosk-external-accounts', {
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    authLevel: 'anonymous',
    route: 'kiosk/external-accounts/{id?}',
    handler: async (request, context) => {
        try {
            const pool = await sql.connect(process.env.SqlConnectionString);
            const id = parseId(request.params.id);

            if (request.params.id && !id) {
                return response(400, { error: 'Invalid external account ID.' });
            }

            switch (request.method.toUpperCase()) {
                case 'GET':
                    return await getAccounts(pool, request, id);
                case 'POST':
                    return await createAccount(pool, request);
                case 'PUT':
                    if (!id) return response(400, { error: 'External account ID is required.' });
                    return await updateAccount(pool, request, id);
                case 'DELETE':
                    if (!id) return response(400, { error: 'External account ID is required.' });
                    return await deactivateAccount(pool, id);
                default:
                    return response(405, { error: 'Method not allowed.' });
            }
        } catch (error) {
            context.error('Kiosk external accounts request failed', error);
            return databaseError(error, 'Kiosk external accounts request failed.');
        }
    }
});

app.http('kiosk-external-account-ledger', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'kiosk/external-accounts/{id}/ledger',
    handler: async (request, context) => {
        try {
            const id = parseId(request.params.id);
            if (!id) return response(400, { error: 'Invalid external account ID.' });

            const dateFrom = nullableDate(request.query.get('dateFrom'));
            const dateTo = nullableDate(request.query.get('dateTo'));
            const requestedLimit = integer(request.query.get('limit') ?? 200);
            const limit = requestedLimit === null
                ? null
                : Math.min(Math.max(requestedLimit, 1), 1000);

            if (request.query.get('dateFrom') && !dateFrom) {
                return response(400, { error: 'dateFrom must use YYYY-MM-DD format.' });
            }
            if (request.query.get('dateTo') && !dateTo) {
                return response(400, { error: 'dateTo must use YYYY-MM-DD format.' });
            }
            if (dateFrom && dateTo && dateFrom > dateTo) {
                return response(400, { error: 'dateFrom cannot be later than dateTo.' });
            }
            if (limit === null) {
                return response(400, { error: 'limit must be an integer between 1 and 1000.' });
            }

            const pool = await sql.connect(process.env.SqlConnectionString);
            const account = await getAccountRow(pool, id);
            if (!account) return response(404, { error: 'External account not found.' });

            const result = await pool.request()
                .input('ExternalAccountID', sql.Int, id)
                .input('DateFrom', sql.Date, dateFrom)
                .input('DateTo', sql.Date, dateTo)
                .input('Limit', sql.Int, limit)
                .query(`
                    WITH CombinedLedger AS
                    (
                        SELECT
                            LedgerEntryID,
                            ExternalAccountID,
                            EntryTime,
                            EntryType,
                            AmountCents,
                            SaleID,
                            SettlementReference,
                            InvoiceNumber,
                            Description,
                            CreatedBy,
                            ReversesLedgerEntryID
                        FROM dbo.ExternalAccountLedger
                        WHERE ExternalAccountID = @ExternalAccountID

                        UNION ALL

                        SELECT
                            CASE WHEN SourceType = N'MealOrder'
                                 THEN -CAST(SourceID AS bigint)
                                 ELSE -CAST(1000000000000 + SourceID AS bigint)
                            END AS LedgerEntryID,
                            ExternalAccountID,
                            CAST(MenuDate AS datetime2(0)) AS EntryTime,
                            N'LunchPurchase' AS EntryType,
                            -ChargeCents AS AmountCents,
                            CAST(NULL AS bigint) AS SaleID,
                            CAST(NULL AS nvarchar(100)) AS SettlementReference,
                            CAST(NULL AS nvarchar(100)) AS InvoiceNumber,
                            CONCAT(N'Lunch: ', ActiveQuantity, N' x ',
                                   CONVERT(decimal(10,2), PriceCents / 100.0), N' EUR',
                                   CASE WHEN NULLIF(ItemName, N'') IS NULL THEN N''
                                        ELSE CONCAT(N' - ', ItemName) END) AS Description,
                            N'LunchApp' AS CreatedBy,
                            CAST(NULL AS bigint) AS ReversesLedgerEntryID
                        FROM dbo.vwExternalLunchChargeEntries
                        WHERE ExternalAccountID = @ExternalAccountID
                    )
                    SELECT TOP (@Limit)
                        LedgerEntryID, ExternalAccountID, EntryTime, EntryType,
                        AmountCents, SaleID, SettlementReference, InvoiceNumber,
                        Description, CreatedBy, ReversesLedgerEntryID
                    FROM CombinedLedger
                    WHERE (@DateFrom IS NULL OR EntryTime >= @DateFrom)
                      AND (@DateTo IS NULL OR EntryTime < DATEADD(day, 1, @DateTo))
                    ORDER BY EntryTime DESC, LedgerEntryID DESC;
                `);

            return response(200, {
                account: mapAccount(account),
                entries: result.recordset.map(mapLedgerEntry)
            });
        } catch (error) {
            context.error('External account ledger request failed', error);
            return databaseError(error, 'External account ledger request failed.');
        }
    }
});

app.http('kiosk-external-account-deposit', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'kiosk/external-accounts/{id}/deposit',
    handler: async (request, context) => {
        return await handleLedgerCredit(request, context, 'Prepayment');
    }
});

app.http('kiosk-external-account-payment', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'kiosk/external-accounts/{id}/payment',
    handler: async (request, context) => {
        return await handleLedgerCredit(request, context, 'Payment');
    }
});

app.http('kiosk-external-account-adjustment', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'kiosk/external-accounts/{id}/adjustment',
    handler: async (request, context) => {
        const id = parseId(request.params.id);
        if (!id) return response(400, { error: 'Invalid external account ID.' });

        let body;
        try { body = await request.json(); }
        catch { return response(400, { error: 'Request body must contain valid JSON.' }); }

        const amountCents = integer(body.amountCents);
        const entryType = normalizeAdjustmentType(body.entryType);
        const createdBy = text(body.createdBy, 100);
        const description = nullableText(body.description, 500);
        const settlementReference = nullableText(body.settlementReference, 100);

        if (!entryType) {
            return response(400, { error: 'entryType must be Credit or Adjustment.' });
        }
        if (amountCents === null || amountCents === 0) {
            return response(400, { error: 'amountCents must be a non-zero integer.' });
        }
        if (!createdBy) return response(400, { error: 'createdBy is required.' });
        if (!description) return response(400, { error: 'description is required for adjustments.' });

        try {
            const pool = await sql.connect(process.env.SqlConnectionString);
            return await insertLedgerEntry(pool, {
                externalAccountId: id,
                entryType,
                amountCents,
                settlementReference,
                invoiceNumber: null,
                description,
                createdBy
            });
        } catch (error) {
            context.error('External account adjustment failed', error);
            return databaseError(error, 'External account adjustment failed.');
        }
    }
});

async function getAccounts(pool, request, id) {
    if (id) {
        const row = await getAccountRow(pool, id);
        if (!row) return response(404, { error: 'External account not found.' });
        return response(200, mapAccount(row));
    }

    const includeInactive = parseBoolean(request.query.get('includeInactive'), false);
    const accountMode = normalizeMode(request.query.get('accountMode'));

    if (request.query.get('accountMode') && !accountMode) {
        return response(400, { error: 'accountMode must be Prepaid, Postpaid or Invoice.' });
    }

    const result = await pool.request()
        .input('IncludeInactive', sql.Bit, includeInactive)
        .input('AccountMode', sql.NVarChar(20), accountMode)
        .query(`
            SELECT
                a.ExternalAccountID,
                a.DisplayName,
                a.CompanyName,
                a.AccountMode,
                a.ExternalReference,
                a.InvoiceReference,
                a.ContactName,
                a.ContactEmail,
                a.CreditLimitCents,
                a.IsActive,
                a.ValidFrom,
                a.ValidUntil,
                a.Notes,
                a.CreatedAt,
                a.UpdatedAt,
                COALESCE(b.BalanceCents, 0) AS BalanceCents,
                COALESCE(b.AvailablePrepaidCents, 0) AS AvailablePrepaidCents,
                COALESCE(b.OutstandingCents, 0) AS OutstandingCents,
                cards.ActiveCardCount,
                cards.TotalCardCount
            FROM dbo.ExternalAccounts a
            LEFT JOIN dbo.vwExternalAccountBalances b
                ON b.ExternalAccountID = a.ExternalAccountID
            OUTER APPLY
            (
                SELECT
                    SUM(CASE WHEN c.IsActive = 1 THEN 1 ELSE 0 END) AS ActiveCardCount,
                    COUNT(*) AS TotalCardCount
                FROM dbo.KioskCards c
                WHERE c.ExternalAccountID = a.ExternalAccountID
            ) cards
            WHERE (@IncludeInactive = 1 OR a.IsActive = 1)
              AND (@AccountMode IS NULL OR a.AccountMode = @AccountMode)
            ORDER BY a.DisplayName, a.ExternalAccountID;
        `);

    return response(200, result.recordset.map(mapAccount));
}

async function getAccountRow(pool, id) {
    const result = await pool.request()
        .input('ExternalAccountID', sql.Int, id)
        .query(`
            SELECT
                a.ExternalAccountID,
                a.DisplayName,
                a.CompanyName,
                a.AccountMode,
                a.ExternalReference,
                a.InvoiceReference,
                a.ContactName,
                a.ContactEmail,
                a.CreditLimitCents,
                a.IsActive,
                a.ValidFrom,
                a.ValidUntil,
                a.Notes,
                a.CreatedAt,
                a.UpdatedAt,
                COALESCE(b.BalanceCents, 0) AS BalanceCents,
                COALESCE(b.AvailablePrepaidCents, 0) AS AvailablePrepaidCents,
                COALESCE(b.OutstandingCents, 0) AS OutstandingCents,
                cards.ActiveCardCount,
                cards.TotalCardCount
            FROM dbo.ExternalAccounts a
            LEFT JOIN dbo.vwExternalAccountBalances b
                ON b.ExternalAccountID = a.ExternalAccountID
            OUTER APPLY
            (
                SELECT
                    SUM(CASE WHEN c.IsActive = 1 THEN 1 ELSE 0 END) AS ActiveCardCount,
                    COUNT(*) AS TotalCardCount
                FROM dbo.KioskCards c
                WHERE c.ExternalAccountID = a.ExternalAccountID
            ) cards
            WHERE a.ExternalAccountID = @ExternalAccountID;
        `);

    return result.recordset[0] || null;
}

async function createAccount(pool, request) {
    const body = await readJson(request);
    const value = validateAccount(body);
    if (value.error) return response(400, { error: value.error });

    const openingBalanceCents = integer(body.openingBalanceCents ?? 0);
    if (openingBalanceCents === null || openingBalanceCents < 0) {
        return response(400, { error: 'openingBalanceCents must be a non-negative integer.' });
    }
    if (openingBalanceCents > 0 && value.accountMode !== 'Prepaid') {
        return response(400, { error: 'openingBalanceCents is only allowed for Prepaid accounts.' });
    }

    const transaction = new sql.Transaction(pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

    try {
        const result = await accountRequest(new sql.Request(transaction), value).query(`
            INSERT dbo.ExternalAccounts
            (
                DisplayName, CompanyName, AccountMode, ExternalReference,
                InvoiceReference, ContactName, ContactEmail, CreditLimitCents,
                IsActive, ValidFrom, ValidUntil, Notes
            )
            OUTPUT inserted.*
            VALUES
            (
                @DisplayName, @CompanyName, @AccountMode, @ExternalReference,
                @InvoiceReference, @ContactName, @ContactEmail, @CreditLimitCents,
                @IsActive, @ValidFrom, @ValidUntil, @Notes
            );
        `);

        const account = mapInsertedAccount(result.recordset[0]);

        if (openingBalanceCents > 0) {
            await new sql.Request(transaction)
                .input('ExternalAccountID', sql.Int, account.externalAccountId)
                .input('AmountCents', sql.Int, openingBalanceCents)
                .input('Description', sql.NVarChar(500), 'Opening balance')
                .input('CreatedBy', sql.NVarChar(100), text(body.createdBy, 100) || 'System')
                .query(`
                    INSERT dbo.ExternalAccountLedger
                        (ExternalAccountID, EntryType, AmountCents, Description, CreatedBy)
                    VALUES
                        (@ExternalAccountID, N'Prepayment', @AmountCents, @Description, @CreatedBy);
                `);

            account.balanceCents = openingBalanceCents;
            account.availablePrepaidCents = openingBalanceCents;
        }

        await transaction.commit();
        return response(201, account);
    } catch (error) {
        await transaction.rollback();
        throw error;
    }
}

async function updateAccount(pool, request, id) {
    const body = await readJson(request);
    const value = validateAccount(body);
    if (value.error) return response(400, { error: value.error });

    const current = await getAccountRow(pool, id);
    if (!current) return response(404, { error: 'External account not found.' });

    if (current.AccountMode !== value.accountMode && Number(current.BalanceCents || 0) !== 0) {
        return response(409, {
            error: 'Account mode cannot be changed while the account balance is non-zero.'
        });
    }

    const result = await accountRequest(
        pool.request().input('ExternalAccountID', sql.Int, id), value
    ).query(`
        UPDATE dbo.ExternalAccounts
        SET DisplayName = @DisplayName,
            CompanyName = @CompanyName,
            AccountMode = @AccountMode,
            ExternalReference = @ExternalReference,
            InvoiceReference = @InvoiceReference,
            ContactName = @ContactName,
            ContactEmail = @ContactEmail,
            CreditLimitCents = @CreditLimitCents,
            IsActive = @IsActive,
            ValidFrom = @ValidFrom,
            ValidUntil = @ValidUntil,
            Notes = @Notes,
            UpdatedAt = SYSUTCDATETIME()
        OUTPUT inserted.*
        WHERE ExternalAccountID = @ExternalAccountID;
    `);

    const account = mapInsertedAccount(result.recordset[0]);
    account.balanceCents = Number(current.BalanceCents || 0);
    account.availablePrepaidCents = value.accountMode === 'Prepaid'
        ? account.balanceCents
        : 0;
    account.outstandingCents = account.balanceCents < 0
        ? -account.balanceCents
        : 0;
    account.activeCardCount = Number(current.ActiveCardCount || 0);
    account.totalCardCount = Number(current.TotalCardCount || 0);

    return response(200, account);
}

async function deactivateAccount(pool, id) {
    const transaction = new sql.Transaction(pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

    try {
        const accountResult = await new sql.Request(transaction)
            .input('ExternalAccountID', sql.Int, id)
            .query(`
                SELECT ExternalAccountID
                FROM dbo.ExternalAccounts WITH (UPDLOCK, HOLDLOCK)
                WHERE ExternalAccountID = @ExternalAccountID;
            `);

        if (!accountResult.recordset.length) {
            await transaction.rollback();
            return response(404, { error: 'External account not found.' });
        }

        await new sql.Request(transaction)
            .input('ExternalAccountID', sql.Int, id)
            .query(`
                UPDATE dbo.ExternalAccounts
                SET IsActive = 0, UpdatedAt = SYSUTCDATETIME()
                WHERE ExternalAccountID = @ExternalAccountID;

                UPDATE dbo.KioskCards
                SET IsActive = 0, UpdatedAt = SYSUTCDATETIME()
                WHERE ExternalAccountID = @ExternalAccountID
                  AND IsActive = 1;
            `);

        await transaction.commit();
        const account = await getAccountRow(pool, id);
        return response(200, mapAccount(account));
    } catch (error) {
        await transaction.rollback();
        throw error;
    }
}

async function handleLedgerCredit(request, context, entryType) {
    const id = parseId(request.params.id);
    if (!id) return response(400, { error: 'Invalid external account ID.' });

    let body;
    try { body = await request.json(); }
    catch { return response(400, { error: 'Request body must contain valid JSON.' }); }

    const amountCents = positiveInteger(body.amountCents);
    const createdBy = text(body.createdBy, 100);
    const description = nullableText(body.description, 500);
    const settlementReference = nullableText(body.settlementReference, 100);
    const invoiceNumber = nullableText(body.invoiceNumber, 100);

    if (!amountCents) return response(400, { error: 'amountCents must be a positive integer.' });
    if (!createdBy) return response(400, { error: 'createdBy is required.' });

    try {
        const pool = await sql.connect(process.env.SqlConnectionString);
        const account = await getAccountRow(pool, id);
        if (!account) return response(404, { error: 'External account not found.' });
        if (!account.IsActive) return response(409, { error: 'External account is inactive.' });

        if (entryType === 'Prepayment' && account.AccountMode !== 'Prepaid') {
            return response(409, { error: 'Deposits are only allowed for Prepaid accounts.' });
        }
        if (entryType === 'Payment' && account.AccountMode === 'Prepaid') {
            return response(409, { error: 'Use the deposit endpoint for Prepaid accounts.' });
        }

        return await insertLedgerEntry(pool, {
            externalAccountId: id,
            entryType,
            amountCents,
            settlementReference,
            invoiceNumber,
            description,
            createdBy
        });
    } catch (error) {
        context.error(`External account ${entryType.toLowerCase()} failed`, error);
        return databaseError(error, `External account ${entryType.toLowerCase()} failed.`);
    }
}

async function insertLedgerEntry(pool, value) {
    const transaction = new sql.Transaction(pool);
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

    try {
        const accountResult = await new sql.Request(transaction)
            .input('ExternalAccountID', sql.Int, value.externalAccountId)
            .query(`
                SELECT ExternalAccountID, IsActive
                FROM dbo.ExternalAccounts WITH (UPDLOCK, HOLDLOCK)
                WHERE ExternalAccountID = @ExternalAccountID;
            `);

        if (!accountResult.recordset.length) {
            await transaction.rollback();
            return response(404, { error: 'External account not found.' });
        }
        if (!accountResult.recordset[0].IsActive) {
            await transaction.rollback();
            return response(409, { error: 'External account is inactive.' });
        }

        const result = await new sql.Request(transaction)
            .input('ExternalAccountID', sql.Int, value.externalAccountId)
            .input('EntryType', sql.NVarChar(30), value.entryType)
            .input('AmountCents', sql.Int, value.amountCents)
            .input('SettlementReference', sql.NVarChar(100), value.settlementReference)
            .input('InvoiceNumber', sql.NVarChar(100), value.invoiceNumber)
            .input('Description', sql.NVarChar(500), value.description)
            .input('CreatedBy', sql.NVarChar(100), value.createdBy)
            .query(`
                INSERT dbo.ExternalAccountLedger
                (
                    ExternalAccountID, EntryType, AmountCents,
                    SettlementReference, InvoiceNumber, Description, CreatedBy
                )
                OUTPUT inserted.*
                VALUES
                (
                    @ExternalAccountID, @EntryType, @AmountCents,
                    @SettlementReference, @InvoiceNumber, @Description, @CreatedBy
                );
            `);

        await transaction.commit();
        const account = await getAccountRow(pool, value.externalAccountId);

        return response(201, {
            entry: mapLedgerEntry(result.recordset[0]),
            account: mapAccount(account)
        });
    } catch (error) {
        await transaction.rollback();
        throw error;
    }
}

function validateAccount(body) {
    const displayName = text(body.displayName, 150);
    const accountMode = normalizeMode(body.accountMode);
    const creditLimitCents = nullableNonNegativeInteger(body.creditLimitCents);
    const validFrom = nullableDate(body.validFrom);
    const validUntil = nullableDate(body.validUntil);
    const contactEmail = nullableText(body.contactEmail, 254);

    if (!displayName) return { error: 'displayName is required.' };
    if (!accountMode) return { error: 'accountMode must be Prepaid, Postpaid or Invoice.' };
    if (body.creditLimitCents !== undefined && body.creditLimitCents !== null && body.creditLimitCents !== '' && creditLimitCents === null) {
        return { error: 'creditLimitCents must be a non-negative integer or null.' };
    }
    if (accountMode === 'Prepaid' && creditLimitCents && creditLimitCents > 0) {
        return { error: 'Prepaid accounts cannot have a credit limit.' };
    }
    if (body.validFrom && !validFrom) return { error: 'validFrom must use YYYY-MM-DD format.' };
    if (body.validUntil && !validUntil) return { error: 'validUntil must use YYYY-MM-DD format.' };
    if (validFrom && validUntil && validFrom > validUntil) {
        return { error: 'validFrom cannot be later than validUntil.' };
    }
    if (contactEmail && !isReasonableEmail(contactEmail)) {
        return { error: 'contactEmail is invalid.' };
    }

    return {
        displayName,
        companyName: nullableText(body.companyName, 200),
        accountMode,
        externalReference: nullableText(body.externalReference, 100),
        invoiceReference: nullableText(body.invoiceReference, 100),
        contactName: nullableText(body.contactName, 150),
        contactEmail,
        creditLimitCents: accountMode === 'Prepaid' ? null : creditLimitCents,
        isActive: parseBoolean(body.isActive, true),
        validFrom,
        validUntil,
        notes: nullableText(body.notes, 1000)
    };
}

function accountRequest(request, value) {
    return request
        .input('DisplayName', sql.NVarChar(150), value.displayName)
        .input('CompanyName', sql.NVarChar(200), value.companyName)
        .input('AccountMode', sql.NVarChar(20), value.accountMode)
        .input('ExternalReference', sql.NVarChar(100), value.externalReference)
        .input('InvoiceReference', sql.NVarChar(100), value.invoiceReference)
        .input('ContactName', sql.NVarChar(150), value.contactName)
        .input('ContactEmail', sql.NVarChar(254), value.contactEmail)
        .input('CreditLimitCents', sql.Int, value.creditLimitCents)
        .input('IsActive', sql.Bit, value.isActive)
        .input('ValidFrom', sql.Date, value.validFrom)
        .input('ValidUntil', sql.Date, value.validUntil)
        .input('Notes', sql.NVarChar(1000), value.notes);
}

function mapAccount(row) {
    return {
        externalAccountId: row.ExternalAccountID,
        displayName: row.DisplayName,
        companyName: row.CompanyName,
        accountMode: row.AccountMode,
        externalReference: row.ExternalReference,
        invoiceReference: row.InvoiceReference,
        contactName: row.ContactName,
        contactEmail: row.ContactEmail,
        creditLimitCents: row.CreditLimitCents,
        isActive: Boolean(row.IsActive),
        validFrom: dateOnly(row.ValidFrom),
        validUntil: dateOnly(row.ValidUntil),
        notes: row.Notes,
        balanceCents: Number(row.BalanceCents || 0),
        availablePrepaidCents: Number(row.AvailablePrepaidCents || 0),
        outstandingCents: Number(row.OutstandingCents || 0),
        activeCardCount: Number(row.ActiveCardCount || 0),
        totalCardCount: Number(row.TotalCardCount || 0),
        createdAt: row.CreatedAt,
        updatedAt: row.UpdatedAt
    };
}

function mapInsertedAccount(row) {
    return {
        externalAccountId: row.ExternalAccountID,
        displayName: row.DisplayName,
        companyName: row.CompanyName,
        accountMode: row.AccountMode,
        externalReference: row.ExternalReference,
        invoiceReference: row.InvoiceReference,
        contactName: row.ContactName,
        contactEmail: row.ContactEmail,
        creditLimitCents: row.CreditLimitCents,
        isActive: Boolean(row.IsActive),
        validFrom: dateOnly(row.ValidFrom),
        validUntil: dateOnly(row.ValidUntil),
        notes: row.Notes,
        balanceCents: 0,
        availablePrepaidCents: 0,
        outstandingCents: 0,
        activeCardCount: 0,
        totalCardCount: 0,
        createdAt: row.CreatedAt,
        updatedAt: row.UpdatedAt
    };
}

function mapLedgerEntry(row) {
    return {
        ledgerEntryId: row.LedgerEntryID,
        externalAccountId: row.ExternalAccountID,
        entryTime: row.EntryTime,
        entryType: row.EntryType,
        amountCents: Number(row.AmountCents),
        saleId: row.SaleID,
        settlementReference: row.SettlementReference,
        invoiceNumber: row.InvoiceNumber,
        description: row.Description,
        createdBy: row.CreatedBy,
        reversesLedgerEntryId: row.ReversesLedgerEntryID
    };
}

async function readJson(request) {
    try { return await request.json(); }
    catch { return {}; }
}

function normalizeMode(value) {
    const mode = String(value || '').trim().toLowerCase();
    if (mode === 'prepaid') return 'Prepaid';
    if (mode === 'postpaid') return 'Postpaid';
    if (mode === 'invoice') return 'Invoice';
    return null;
}

function normalizeAdjustmentType(value) {
    const type = String(value || '').trim().toLowerCase();
    if (type === 'credit') return 'Credit';
    if (type === 'adjustment') return 'Adjustment';
    return null;
}

function parseId(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function positiveInteger(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function integer(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isInteger(n) ? n : null;
}

function nullableNonNegativeInteger(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = integer(value);
    return n !== null && n >= 0 ? n : null;
}

function text(value, maxLength) {
    return typeof value === 'string'
        ? value.trim().slice(0, maxLength)
        : '';
}

function nullableText(value, maxLength) {
    const result = text(value, maxLength);
    return result || null;
}

function nullableDate(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
        ? value
        : null;
}

function dateOnly(value) {
    if (!value) return null;
    return typeof value === 'string'
        ? value.slice(0, 10)
        : value.toISOString().slice(0, 10);
}

function parseBoolean(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return String(value).toLowerCase() === 'true' || String(value) === '1';
}

function isReasonableEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function response(status, jsonBody) {
    return { status, jsonBody };
}

function databaseError(error, message) {
    if (error.number === 2601 || error.number === 2627) {
        return response(409, {
            error: 'A conflicting external account record already exists.',
            details: error.message
        });
    }
    if (error.number === 547) {
        return response(409, {
            error: 'The external account is referenced by another record.',
            details: error.message
        });
    }
    return response(500, { error: message, details: error.message });
}
