const { app } = require('@azure/functions');
const sql = require('mssql');

const REPORT_TIME_ZONE = 'FLE Standard Time';
const MAX_RANGE_DAYS = 370;
const MAX_PAGE_SIZE = 200;

class HttpError extends Error {
    constructor(status, message, details) {
        super(message);
        this.status = status;
        this.details = details;
    }
}

app.http('kiosk-reports', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'kiosk/reports/{report?}',
    handler: async (request, context) => {
        try {
            const report = String(request.params.report || 'overview').toLowerCase();
            const query = Object.fromEntries(request.query.entries());
            const period = parsePeriod(query.from, query.to);
            const pool = await sql.connect(process.env.SqlConnectionString);

            switch (report) {
                case 'overview':
                    return jsonResponse(200, await getOverview(pool, period, parseGroupBy(query.groupBy)));
                case 'transactions':
                    return jsonResponse(200, await getTransactions(pool, period, query));
                case 'payroll':
                    return jsonResponse(200, await getPayroll(pool, period));
                case 'external-invoicing':
                    return jsonResponse(200, await getExternalInvoicing(pool, period, query.accountMode));
                case 'export':
                    return await exportReport(pool, period, query);
                default:
                    throw new HttpError(404, 'Unknown report type.');
            }
        } catch (error) {
            context.error('Kiosk reporting request failed', error);
            return errorResponse(error);
        }
    }
});

async function getOverview(pool, period, groupBy) {
    const summaryResult = await reportRequest(pool, period).query(`
        SELECT
            COALESCE(SUM(CONVERT(BIGINT, s.TotalCents)), 0) AS TotalSalesCents,
            COUNT_BIG(*) AS TransactionCount,
            COALESCE(SUM(CONVERT(BIGINT, lineTotals.ProductQuantity)), 0) AS ProductQuantity,
            COALESCE(SUM(CASE WHEN s.OwnerType = N'Employee' THEN CONVERT(BIGINT, s.TotalCents) ELSE 0 END), 0) AS EmployeeSalesCents,
            COALESCE(SUM(CASE WHEN s.OwnerType = N'External' THEN CONVERT(BIGINT, s.TotalCents) ELSE 0 END), 0) AS ExternalSalesCents,
            SUM(CASE WHEN s.OwnerType = N'Employee' THEN 1 ELSE 0 END) AS EmployeeTransactionCount,
            SUM(CASE WHEN s.OwnerType = N'External' THEN 1 ELSE 0 END) AS ExternalTransactionCount
        FROM dbo.KioskSales AS s
        OUTER APPLY
        (
            SELECT SUM(CONVERT(BIGINT, sl.Quantity)) AS ProductQuantity
            FROM dbo.KioskSaleLines AS sl
            WHERE sl.SaleID = s.SaleID
        ) AS lineTotals
        CROSS APPLY
        (
            SELECT
                CONVERT(DATETIME2, CAST(@FromDate AS DATE) AT TIME ZONE '${REPORT_TIME_ZONE}' AT TIME ZONE 'UTC') AS FromUtc,
                CONVERT(DATETIME2, DATEADD(DAY, 1, CAST(@ToDate AS DATE)) AT TIME ZONE '${REPORT_TIME_ZONE}' AT TIME ZONE 'UTC') AS ToUtc
        ) AS boundaries
        WHERE s.SaleTime >= boundaries.FromUtc
          AND s.SaleTime < boundaries.ToUtc
          AND s.Status = N'Completed';
    `);

    const trendResult = await reportRequest(pool, period)
        .input('GroupBy', sql.NVarChar(10), groupBy)
        .query(`
            WITH Source AS
            (
                SELECT
                    s.SaleID,
                    s.SaleTime,
                    s.TotalCents,
                    localTime.LocalSaleDate,
                    CASE
                        WHEN @GroupBy = N'month' THEN DATEFROMPARTS(YEAR(localTime.LocalSaleDate), MONTH(localTime.LocalSaleDate), 1)
                        WHEN @GroupBy = N'week' THEN DATEADD(DAY, -(DATEDIFF(DAY, '19000101', localTime.LocalSaleDate) % 7), localTime.LocalSaleDate)
                        ELSE localTime.LocalSaleDate
                    END AS PeriodStart
                FROM dbo.KioskSales AS s
                CROSS APPLY
                (
                    SELECT CAST((s.SaleTime AT TIME ZONE 'UTC' AT TIME ZONE '${REPORT_TIME_ZONE}') AS DATE) AS LocalSaleDate
                ) AS localTime
                WHERE localTime.LocalSaleDate >= CAST(@FromDate AS DATE)
                  AND localTime.LocalSaleDate <= CAST(@ToDate AS DATE)
                  AND s.Status = N'Completed'
            )
            SELECT
                PeriodStart,
                CASE
                    WHEN @GroupBy = N'month' THEN EOMONTH(PeriodStart)
                    WHEN @GroupBy = N'week' THEN DATEADD(DAY, 6, PeriodStart)
                    ELSE PeriodStart
                END AS PeriodEnd,
                SUM(CONVERT(BIGINT, TotalCents)) AS TotalSalesCents,
                COUNT_BIG(*) AS TransactionCount,
                SUM(CONVERT(BIGINT, quantities.ProductQuantity)) AS ProductQuantity
            FROM Source
            OUTER APPLY
            (
                SELECT COALESCE(SUM(CONVERT(BIGINT, sl.Quantity)), 0) AS ProductQuantity
                FROM dbo.KioskSaleLines AS sl
                WHERE sl.SaleID = Source.SaleID
            ) AS quantities
            GROUP BY PeriodStart
            ORDER BY PeriodStart;
        `);

    const productsResult = await reportRequest(pool, period).query(`
        SELECT TOP (20)
            sl.ProductID,
            MAX(sl.ProductNameSnapshot) AS ProductName,
            SUM(CONVERT(BIGINT, sl.Quantity)) AS Quantity,
            SUM(CONVERT(BIGINT, sl.LineTotalCents)) AS TotalSalesCents
        FROM dbo.KioskSales AS s
        INNER JOIN dbo.KioskSaleLines AS sl ON sl.SaleID = s.SaleID
        CROSS APPLY
        (
            SELECT CAST((s.SaleTime AT TIME ZONE 'UTC' AT TIME ZONE '${REPORT_TIME_ZONE}') AS DATE) AS LocalSaleDate
        ) AS localTime
        WHERE localTime.LocalSaleDate >= CAST(@FromDate AS DATE)
          AND localTime.LocalSaleDate <= CAST(@ToDate AS DATE)
          AND s.Status = N'Completed'
        GROUP BY sl.ProductID
        ORDER BY Quantity DESC, TotalSalesCents DESC, ProductName;
    `);

    const summary = summaryResult.recordset[0];
    return {
        period: periodPayload(period, { groupBy, timeZone: 'Europe/Helsinki' }),
        summary: {
            totalSalesCents: number(summary.TotalSalesCents),
            transactionCount: number(summary.TransactionCount),
            productQuantity: number(summary.ProductQuantity),
            employeeSalesCents: number(summary.EmployeeSalesCents),
            externalSalesCents: number(summary.ExternalSalesCents),
            employeeTransactionCount: number(summary.EmployeeTransactionCount),
            externalTransactionCount: number(summary.ExternalTransactionCount)
        },
        trend: trendResult.recordset.map(row => ({
            periodStart: dateOnly(row.PeriodStart),
            periodEnd: dateOnly(row.PeriodEnd),
            totalSalesCents: number(row.TotalSalesCents),
            transactionCount: number(row.TransactionCount),
            productQuantity: number(row.ProductQuantity)
        })),
        topProducts: productsResult.recordset.map(row => ({
            productId: number(row.ProductID),
            productName: row.ProductName,
            quantity: number(row.Quantity),
            totalSalesCents: number(row.TotalSalesCents)
        }))
    };
}

async function getTransactions(pool, period, query) {
    const page = positiveInteger(query.page) || 1;
    const pageSize = Math.min(positiveInteger(query.pageSize) || 50, MAX_PAGE_SIZE);
    const offset = (page - 1) * pageSize;
    const ownerType = normalizeOwnerType(query.ownerType);
    const status = normalizeStatus(query.status);

    const result = await reportRequest(pool, period)
        .input('OwnerType', sql.NVarChar(20), ownerType)
        .input('Status', sql.NVarChar(20), status)
        .input('Offset', sql.Int, offset)
        .input('PageSize', sql.Int, pageSize)
        .query(`
            WITH Filtered AS
            (
                SELECT
                    s.SaleID,
                    s.SaleTime,
                    s.Status,
                    s.OwnerType,
                    s.EmployeeNo,
                    s.ExternalAccountID,
                    s.TotalCents,
                    CASE
                        WHEN s.OwnerType = N'Employee' THEN NULLIF(LTRIM(RTRIM(CONCAT(e.FirstName, N' ', e.LastName))), N'')
                        ELSE COALESCE(c.CardHolderName, a.DisplayName)
                    END AS DisplayName,
                    a.CompanyName,
                    a.AccountMode,
                    COUNT_BIG(*) OVER() AS TotalRows
                FROM dbo.KioskSales AS s
                LEFT JOIN dbo.Employees AS e ON e.EmployeeNo = s.EmployeeNo
                LEFT JOIN dbo.KioskCards AS c ON c.CardID = s.CardID
                LEFT JOIN dbo.ExternalAccounts AS a ON a.ExternalAccountID = s.ExternalAccountID
                CROSS APPLY
                (
                    SELECT CAST((s.SaleTime AT TIME ZONE 'UTC' AT TIME ZONE '${REPORT_TIME_ZONE}') AS DATE) AS LocalSaleDate
                ) AS localTime
                WHERE localTime.LocalSaleDate >= CAST(@FromDate AS DATE)
                  AND localTime.LocalSaleDate <= CAST(@ToDate AS DATE)
                  AND (@OwnerType IS NULL OR s.OwnerType = @OwnerType)
                  AND (@Status IS NULL OR s.Status = @Status)
            )
            SELECT *
            FROM Filtered
            ORDER BY SaleTime DESC, SaleID DESC
            OFFSET @Offset ROWS FETCH NEXT @PageSize ROWS ONLY;
        `);

    const saleIds = result.recordset.map(row => number(row.SaleID));
    let lines = [];
    if (saleIds.length) {
        const linesResult = await pool.request()
            .input('SaleIDs', sql.NVarChar(sql.MAX), JSON.stringify(saleIds))
            .query(`
                SELECT
                    sl.SaleID,
                    sl.SaleLineID,
                    sl.ProductID,
                    sl.ProductNameSnapshot,
                    sl.UnitPriceCents,
                    sl.Quantity,
                    sl.LineTotalCents
                FROM dbo.KioskSaleLines AS sl
                INNER JOIN OPENJSON(@SaleIDs) WITH (SaleID BIGINT '$') AS requested
                    ON requested.SaleID = sl.SaleID
                ORDER BY sl.SaleID, sl.SaleLineID;
            `);
        lines = linesResult.recordset;
    }

    const linesBySale = new Map();
    for (const line of lines) {
        const saleId = number(line.SaleID);
        if (!linesBySale.has(saleId)) linesBySale.set(saleId, []);
        linesBySale.get(saleId).push({
            saleLineId: number(line.SaleLineID),
            productId: number(line.ProductID),
            productName: line.ProductNameSnapshot,
            unitPriceCents: number(line.UnitPriceCents),
            quantity: number(line.Quantity),
            lineTotalCents: number(line.LineTotalCents)
        });
    }

    return {
        period: periodPayload(period),
        page,
        pageSize,
        totalRows: result.recordset.length ? number(result.recordset[0].TotalRows) : 0,
        rows: result.recordset.map(row => ({
            saleId: number(row.SaleID),
            saleTime: row.SaleTime,
            status: row.Status,
            ownerType: String(row.OwnerType).toLowerCase(),
            employeeNo: nullableNumber(row.EmployeeNo),
            externalAccountId: nullableNumber(row.ExternalAccountID),
            displayName: row.DisplayName,
            companyName: row.CompanyName,
            accountMode: row.AccountMode,
            totalCents: number(row.TotalCents),
            items: linesBySale.get(number(row.SaleID)) || []
        }))
    };
}

async function getPayroll(pool, period) {
    const result = await reportRequest(pool, period).query(`
        SELECT
            s.EmployeeNo,
            NULLIF(LTRIM(RTRIM(CONCAT(e.FirstName, N' ', e.LastName))), N'') AS EmployeeName,
            COUNT_BIG(*) AS TransactionCount,
            SUM(CONVERT(BIGINT, s.TotalCents)) AS TotalCents
        FROM dbo.KioskSales AS s
        LEFT JOIN dbo.Employees AS e ON e.EmployeeNo = s.EmployeeNo
        CROSS APPLY
        (
            SELECT CAST((s.SaleTime AT TIME ZONE 'UTC' AT TIME ZONE '${REPORT_TIME_ZONE}') AS DATE) AS LocalSaleDate
        ) AS localTime
        WHERE localTime.LocalSaleDate >= CAST(@FromDate AS DATE)
          AND localTime.LocalSaleDate <= CAST(@ToDate AS DATE)
          AND s.Status = N'Completed'
          AND s.OwnerType = N'Employee'
          AND s.EmployeeNo IS NOT NULL
        GROUP BY s.EmployeeNo, e.FirstName, e.LastName
        ORDER BY s.EmployeeNo;
    `);

    const rows = result.recordset.map(row => ({
        employeeNo: number(row.EmployeeNo),
        employeeName: row.EmployeeName || `Employee ${row.EmployeeNo}`,
        transactionCount: number(row.TransactionCount),
        totalCents: number(row.TotalCents)
    }));

    return {
        period: periodPayload(period),
        summary: {
            employeeCount: rows.length,
            transactionCount: rows.reduce((sum, row) => sum + row.transactionCount, 0),
            totalCents: rows.reduce((sum, row) => sum + row.totalCents, 0)
        },
        rows
    };
}

async function getExternalInvoicing(pool, period, requestedModes) {
    const modes = parseAccountModes(requestedModes);
    const result = await reportRequest(pool, period)
        .input('ModesJson', sql.NVarChar(sql.MAX), JSON.stringify(modes))
        .query(`
            SELECT
                s.ExternalAccountID,
                a.DisplayName,
                a.CompanyName,
                a.AccountMode,
                COUNT_BIG(*) AS TransactionCount,
                SUM(CONVERT(BIGINT, s.TotalCents)) AS TotalCents
            FROM dbo.KioskSales AS s
            INNER JOIN dbo.ExternalAccounts AS a ON a.ExternalAccountID = s.ExternalAccountID
            INNER JOIN OPENJSON(@ModesJson) WITH (AccountMode NVARCHAR(20) '$') AS requested
                ON requested.AccountMode = a.AccountMode
            CROSS APPLY
            (
                SELECT CAST((s.SaleTime AT TIME ZONE 'UTC' AT TIME ZONE '${REPORT_TIME_ZONE}') AS DATE) AS LocalSaleDate
            ) AS localTime
            WHERE localTime.LocalSaleDate >= CAST(@FromDate AS DATE)
              AND localTime.LocalSaleDate <= CAST(@ToDate AS DATE)
              AND s.Status = N'Completed'
              AND s.OwnerType = N'External'
              AND s.ExternalAccountID IS NOT NULL
            GROUP BY s.ExternalAccountID, a.DisplayName, a.CompanyName, a.AccountMode
            ORDER BY COALESCE(a.CompanyName, a.DisplayName), s.ExternalAccountID;
        `);

    const rows = result.recordset.map(row => ({
        externalAccountId: number(row.ExternalAccountID),
        displayName: row.DisplayName,
        companyName: row.CompanyName,
        accountMode: row.AccountMode,
        transactionCount: number(row.TransactionCount),
        totalCents: number(row.TotalCents)
    }));

    return {
        period: periodPayload(period, { accountModes: modes }),
        summary: {
            accountCount: rows.length,
            transactionCount: rows.reduce((sum, row) => sum + row.transactionCount, 0),
            totalCents: rows.reduce((sum, row) => sum + row.totalCents, 0)
        },
        rows
    };
}

async function getExternalDetails(pool, period, requestedModes) {
    const modes = parseAccountModes(requestedModes);
    const result = await reportRequest(pool, period)
        .input('ModesJson', sql.NVarChar(sql.MAX), JSON.stringify(modes))
        .query(`
            SELECT
                s.ExternalAccountID,
                a.DisplayName,
                a.CompanyName,
                a.AccountMode,
                c.CardHolderName,
                s.SaleID,
                s.SaleTime,
                s.TotalCents
            FROM dbo.KioskSales AS s
            INNER JOIN dbo.ExternalAccounts AS a ON a.ExternalAccountID = s.ExternalAccountID
            LEFT JOIN dbo.KioskCards AS c ON c.CardID = s.CardID
            INNER JOIN OPENJSON(@ModesJson) WITH (AccountMode NVARCHAR(20) '$') AS requested
                ON requested.AccountMode = a.AccountMode
            CROSS APPLY
            (
                SELECT CAST((s.SaleTime AT TIME ZONE 'UTC' AT TIME ZONE '${REPORT_TIME_ZONE}') AS DATE) AS LocalSaleDate
            ) AS localTime
            WHERE localTime.LocalSaleDate >= CAST(@FromDate AS DATE)
              AND localTime.LocalSaleDate <= CAST(@ToDate AS DATE)
              AND s.Status = N'Completed'
              AND s.OwnerType = N'External'
            ORDER BY COALESCE(a.CompanyName, a.DisplayName), s.SaleTime, s.SaleID;
        `);

    return result.recordset.map(row => ({
        externalAccountId: number(row.ExternalAccountID),
        displayName: row.DisplayName,
        companyName: row.CompanyName,
        accountMode: row.AccountMode,
        cardHolderName: row.CardHolderName,
        saleId: number(row.SaleID),
        saleTime: row.SaleTime,
        totalCents: number(row.TotalCents)
    }));
}

async function exportReport(pool, period, query) {
    const type = String(query.type || query.report || '').toLowerCase();
    let columns;
    let rows;
    let filePrefix;

    if (type === 'payroll') {
        const report = await getPayroll(pool, period);
        columns = [
            ['PeriodStart', () => period.from],
            ['PeriodEnd', () => period.to],
            ['EmployeeNo', row => row.employeeNo],
            ['EmployeeName', row => row.employeeName],
            ['TransactionCount', row => row.transactionCount],
            ['TotalAmount', row => decimalEuros(row.totalCents)]
        ];
        rows = report.rows;
        filePrefix = 'cafe-kiosk-payroll';
    } else if (type === 'external-summary') {
        const report = await getExternalInvoicing(pool, period, query.accountMode);
        columns = [
            ['PeriodStart', () => period.from],
            ['PeriodEnd', () => period.to],
            ['ExternalAccountID', row => row.externalAccountId],
            ['DisplayName', row => row.displayName],
            ['CompanyName', row => row.companyName],
            ['AccountMode', row => row.accountMode],
            ['TransactionCount', row => row.transactionCount],
            ['TotalAmount', row => decimalEuros(row.totalCents)]
        ];
        rows = report.rows;
        filePrefix = 'cafe-kiosk-external-summary';
    } else if (type === 'external-details') {
        rows = await getExternalDetails(pool, period, query.accountMode);
        columns = [
            ['PeriodStart', () => period.from],
            ['PeriodEnd', () => period.to],
            ['ExternalAccountID', row => row.externalAccountId],
            ['DisplayName', row => row.displayName],
            ['CompanyName', row => row.companyName],
            ['AccountMode', row => row.accountMode],
            ['CardHolderName', row => row.cardHolderName],
            ['SaleID', row => row.saleId],
            ['SaleTimeUTC', row => isoValue(row.saleTime)],
            ['TotalAmount', row => decimalEuros(row.totalCents)]
        ];
        filePrefix = 'cafe-kiosk-external-details';
    } else {
        throw new HttpError(400, 'Export type must be payroll, external-summary, or external-details.');
    }

    const csv = createCsv(columns, rows);
    const filename = `${filePrefix}-${period.from}_${period.to}.csv`;
    return {
        status: 200,
        headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Cache-Control': 'no-store'
        },
        body: `\uFEFF${csv}`
    };
}

function reportRequest(pool, period) {
    return pool.request()
        .input('FromDate', sql.Date, period.from)
        .input('ToDate', sql.Date, period.to);
}

function parsePeriod(fromValue, toValue) {
    const today = new Date();
    const defaultTo = formatDateUtc(today);
    const defaultFromDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const from = parseIsoDate(fromValue || formatDateUtc(defaultFromDate), 'from');
    const to = parseIsoDate(toValue || defaultTo, 'to');
    const fromDate = new Date(`${from}T00:00:00Z`);
    const toDate = new Date(`${to}T00:00:00Z`);

    if (fromDate > toDate) throw new HttpError(400, 'from must be on or before to.');
    const days = Math.floor((toDate - fromDate) / 86400000) + 1;
    if (days > MAX_RANGE_DAYS) throw new HttpError(400, `Date range may not exceed ${MAX_RANGE_DAYS} days.`);
    return { from, to, days };
}

function parseIsoDate(value, name) {
    const text = String(value || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new HttpError(400, `${name} must use yyyy-MM-dd.`);
    const date = new Date(`${text}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || formatDateUtc(date) !== text) throw new HttpError(400, `${name} is not a valid date.`);
    return text;
}

function parseGroupBy(value) {
    const groupBy = String(value || 'day').toLowerCase();
    if (!['day', 'week', 'month'].includes(groupBy)) throw new HttpError(400, 'groupBy must be day, week, or month.');
    return groupBy;
}

function parseAccountModes(value) {
    const supplied = String(value || 'Invoice').split(',').map(item => item.trim()).filter(Boolean);
    const map = { prepaid: 'Prepaid', postpaid: 'Postpaid', invoice: 'Invoice' };
    const modes = [...new Set(supplied.map(item => map[item.toLowerCase()]).filter(Boolean))];
    if (!modes.length) throw new HttpError(400, 'accountMode must contain Prepaid, Postpaid, or Invoice.');
    return modes;
}

function normalizeOwnerType(value) {
    if (!value) return null;
    const normalized = String(value).toLowerCase();
    if (normalized === 'employee') return 'Employee';
    if (normalized === 'external') return 'External';
    throw new HttpError(400, 'ownerType must be employee or external.');
}

function normalizeStatus(value) {
    if (!value) return null;
    const normalized = String(value).toLowerCase();
    if (normalized === 'completed') return 'Completed';
    if (normalized === 'voided') return 'Voided';
    throw new HttpError(400, 'status must be Completed or Voided.');
}

function createCsv(columns, rows) {
    const output = [columns.map(column => csvCell(column[0])).join(';')];
    for (const row of rows) output.push(columns.map(column => csvCell(column[1](row))).join(';'));
    return output.join('\r\n');
}

function csvCell(value) {
    const text = value === null || value === undefined ? '' : String(value);
    return `"${text.replaceAll('"', '""')}"`;
}

function decimalEuros(cents) {
    return (number(cents) / 100).toFixed(2).replace('.', ',');
}

function periodPayload(period, extra = {}) {
    return { from: period.from, to: period.to, ...extra };
}

function positiveInteger(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function number(value) {
    return Number(value || 0);
}

function nullableNumber(value) {
    return value === null || value === undefined ? null : Number(value);
}

function dateOnly(value) {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value).slice(0, 10);
}

function isoValue(value) {
    return value instanceof Date ? value.toISOString() : String(value || '');
}

function formatDateUtc(date) {
    return date.toISOString().slice(0, 10);
}

function jsonResponse(status, jsonBody) {
    return { status, jsonBody, headers: { 'Cache-Control': 'no-store' } };
}

function errorResponse(error) {
    if (error instanceof HttpError) {
        return jsonResponse(error.status, {
            error: error.message,
            ...(error.details ? { details: error.details } : {})
        });
    }
    return jsonResponse(500, { error: 'Kiosk reporting request failed.', details: error.message });
}
