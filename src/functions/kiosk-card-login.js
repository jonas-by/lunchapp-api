const { app } = require('@azure/functions');
const sql = require('mssql');

app.http('kiosk-card-login', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'kiosk/card-login',
    handler: async (request, context) => {
        let body;
        try { body = await request.json(); }
        catch { return response(400, { error: 'Request body must contain valid JSON.' }); }

        const cardNumber = text(body.cardNumber, 100);
        if (!cardNumber) return response(400, { error: 'cardNumber is required.' });

        try {
            const pool = await sql.connect(process.env.SqlConnectionString);
            const result = await pool.request()
                .input('CardNumber', sql.NVarChar(100), cardNumber)
                .query(`
                    SELECT
                        c.CardID,
                        c.CardNumber,
                        c.OwnerType,
                        c.EmployeeNo,
                        c.ExternalAccountID,
                        c.DisplayNameOverride,
                        c.IsActive AS CardIsActive,
                        c.ValidFrom AS CardValidFrom,
                        c.ValidUntil AS CardValidUntil,
                        e.FirstName,
                        e.LastName,
                        a.DisplayName AS ExternalDisplayName,
                        a.CompanyName,
                        a.AccountMode,
                        a.CreditLimitCents,
                        a.IsActive AS AccountIsActive,
                        a.ValidFrom AS AccountValidFrom,
                        a.ValidUntil AS AccountValidUntil,
                        COALESCE(b.BalanceCents, 0) AS BalanceCents,
                        COALESCE(b.AvailablePrepaidCents, 0) AS AvailablePrepaidCents,
                        COALESCE(b.OutstandingCents, 0) AS OutstandingCents
                    FROM dbo.KioskCards c
                    LEFT JOIN dbo.Employees e
                        ON c.OwnerType = N'Employee'
                       AND e.EmployeeNo = c.EmployeeNo
                    LEFT JOIN dbo.ExternalAccounts a
                        ON c.OwnerType = N'External'
                       AND a.ExternalAccountID = c.ExternalAccountID
                    LEFT JOIN dbo.vwExternalAccountBalances b
                        ON b.ExternalAccountID = c.ExternalAccountID
                    WHERE c.CardNumber = @CardNumber;
                `);

            if (!result.recordset.length) {
                return response(404, { error: 'Card not found.' });
            }

            const card = result.recordset[0];
            const now = new Date();

            if (!card.CardIsActive) return response(403, { error: 'Card is inactive.' });
            if (card.CardValidFrom && now < new Date(card.CardValidFrom)) return response(403, { error: 'Card is not valid yet.' });
            if (card.CardValidUntil && now > new Date(card.CardValidUntil)) return response(403, { error: 'Card has expired.' });

            if (card.OwnerType === 'Employee') {
                const employeeName = [card.FirstName, card.LastName].filter(Boolean).join(' ');
                return response(200, {
                    cardId: card.CardID,
                    cardNumber: card.CardNumber,
                    ownerType: 'employee',
                    employeeNo: card.EmployeeNo,
                    displayName: card.DisplayNameOverride || employeeName || `Employee ${card.EmployeeNo}`
                });
            }

            if (!card.AccountIsActive) return response(403, { error: 'External account is inactive.' });
            const today = new Date().toISOString().slice(0, 10);
            if (card.AccountValidFrom && today < dateOnly(card.AccountValidFrom)) return response(403, { error: 'External account is not valid yet.' });
            if (card.AccountValidUntil && today > dateOnly(card.AccountValidUntil)) return response(403, { error: 'External account has expired.' });

            return response(200, {
                cardId: card.CardID,
                cardNumber: card.CardNumber,
                ownerType: 'external',
                externalAccountId: card.ExternalAccountID,
                displayName: card.DisplayNameOverride || card.ExternalDisplayName,
                companyName: card.CompanyName,
                accountMode: card.AccountMode,
                creditLimitCents: card.CreditLimitCents,
                balanceCents: Number(card.BalanceCents),
                availableBalanceCents: Number(card.AvailablePrepaidCents),
                outstandingCents: Number(card.OutstandingCents)
            });
        } catch (error) {
            context.error('Kiosk card login failed', error);
            return response(500, { error: 'Kiosk card login failed.', details: error.message });
        }
    }
});

function text(value, max) { return typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, max) : ''; }
function dateOnly(value) { return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10); }
function response(status, jsonBody) { return { status, jsonBody }; }
