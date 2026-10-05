const { app } = require('@azure/functions');
const sql = require('mssql');

app.http('kitchen-orders', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'kitchen/orders',
    handler: async (request, context) => {
        const dateFrom = request.query.get('dateFrom');
        const dateTo = request.query.get('dateTo');
        if (!isDate(dateFrom) || !isDate(dateTo) || dateFrom > dateTo) {
            return { status: 400, jsonBody: { error: 'Valid dateFrom and dateTo are required' } };
        }

        try {
            const pool = await sql.connect(process.env.SqlConnectionString);
            const result = await pool.request()
                .input('dateFrom', sql.Date, dateFrom)
                .input('dateTo', sql.Date, dateTo)
                .query(`
                    WITH EmployeeMealCancellations AS
                    (
                        SELECT OrderID, SUM(Quantity) AS Cancelled
                        FROM dbo.OrderCancellations
                        WHERE OrderType = N'Employee'
                        GROUP BY OrderID
                    ),
                    GuestMealCancellations AS
                    (
                        SELECT GuestOrderID, SUM(Quantity) AS Cancelled
                        FROM dbo.OrderCancellations
                        WHERE OrderType = N'Guest'
                        GROUP BY GuestOrderID
                    )
                    SELECT
                        N'meal' AS ItemType,
                        N'employee' AS OrderType,
                        o.OrderID,
                        CAST(NULL AS int) AS GuestOrderID,
                        CAST(NULL AS int) AS SaladOrderID,
                        CAST(NULL AS int) AS GuestSaladOrderID,
                        o.MenuDate,
                        o.EmployeeNo,
                        COALESCE(e.FirstName, kc.CardHolderName, a.DisplayName, N'External account') AS FirstName,
                        e.LastName,
                        o.OrderedMealID AS ItemID,
                        m.NameEN,
                        m.NameSV,
                        m.NameFI,
                        m.Category,
                        o.Quantity - COALESCE(c.Cancelled, 0) AS ActiveQuantity,
                        CAST(NULL AS nvarchar(200)) AS WorkTask,
                        o.OrderTime
                    FROM dbo.Orders o
                    INNER JOIN dbo.Meals m ON m.MealID = o.OrderedMealID
                    LEFT JOIN dbo.Employees e ON e.EmployeeNo = o.EmployeeNo
                    LEFT JOIN dbo.ExternalAccounts a ON a.ExternalAccountID = o.ExternalAccountID
                    OUTER APPLY
                    (
                        SELECT TOP (1) c.CardHolderName
                        FROM dbo.KioskCards c
                        WHERE c.ExternalAccountID = o.ExternalAccountID
                          AND NULLIF(LTRIM(RTRIM(c.CardHolderName)), N'') IS NOT NULL
                        ORDER BY c.IsActive DESC, c.CardID
                    ) kc
                    LEFT JOIN EmployeeMealCancellations c ON c.OrderID = o.OrderID
                    WHERE o.MenuDate BETWEEN @dateFrom AND @dateTo
                      AND o.Quantity - COALESCE(c.Cancelled, 0) > 0

                    UNION ALL

                    SELECT
                        N'meal', N'guest',
                        CAST(NULL AS int), go.GuestOrderID,
                        CAST(NULL AS int), CAST(NULL AS int),
                        go.MenuDate, go.HostEmployeeNo,
                        e.FirstName, e.LastName,
                        go.OrderedMealID,
                        m.NameEN, m.NameSV, m.NameFI, m.Category,
                        go.Quantity - COALESCE(c.Cancelled, 0),
                        go.WorkTask, go.OrderTime
                    FROM dbo.GuestOrders go
                    INNER JOIN dbo.Meals m ON m.MealID = go.OrderedMealID
                    LEFT JOIN dbo.Employees e ON e.EmployeeNo = go.HostEmployeeNo
                    LEFT JOIN GuestMealCancellations c ON c.GuestOrderID = go.GuestOrderID
                    WHERE go.MenuDate BETWEEN @dateFrom AND @dateTo
                      AND go.Quantity - COALESCE(c.Cancelled, 0) > 0

                    UNION ALL

                    SELECT
                        N'salad', N'employee',
                        CAST(NULL AS int), CAST(NULL AS int),
                        so.SaladOrderID, CAST(NULL AS int),
                        so.MenuDate, so.EmployeeNo,
                        COALESCE(e.FirstName, kc.CardHolderName, a.DisplayName, N'External account') AS FirstName,
                        e.LastName,
                        so.SaladID,
                        s.NameEn, s.NameSv, s.NameFi, N'Salad',
                        so.Quantity - COALESCE(c.Cancelled, 0),
                        CAST(NULL AS nvarchar(200)), so.OrderTime
                    FROM dbo.SaladOrders so
                    INNER JOIN dbo.Salads s ON s.SaladID = so.SaladID
                    LEFT JOIN dbo.Employees e ON e.EmployeeNo = so.EmployeeNo
                    LEFT JOIN dbo.ExternalAccounts a ON a.ExternalAccountID = so.ExternalAccountID
                    OUTER APPLY
                    (
                        SELECT TOP (1) c.CardHolderName
                        FROM dbo.KioskCards c
                        WHERE c.ExternalAccountID = so.ExternalAccountID
                          AND NULLIF(LTRIM(RTRIM(c.CardHolderName)), N'') IS NOT NULL
                        ORDER BY c.IsActive DESC, c.CardID
                    ) kc
                    OUTER APPLY
                    (
                        SELECT SUM(sc.Quantity) AS Cancelled
                        FROM dbo.SaladOrderCancellations sc
                        WHERE sc.OrderType = N'Employee'
                          AND sc.SaladOrderID = so.SaladOrderID
                    ) c
                    WHERE so.MenuDate BETWEEN @dateFrom AND @dateTo
                      AND so.Quantity - COALESCE(c.Cancelled, 0) > 0

                    UNION ALL

                    SELECT
                        N'salad', N'guest',
                        CAST(NULL AS int), CAST(NULL AS int),
                        CAST(NULL AS int), gso.GuestSaladOrderID,
                        gso.MenuDate, gso.HostEmployeeNo,
                        e.FirstName, e.LastName,
                        gso.SaladID,
                        s.NameEn, s.NameSv, s.NameFi, N'Salad',
                        gso.Quantity - COALESCE(c.Cancelled, 0),
                        gso.WorkTask, gso.OrderTime
                    FROM dbo.GuestSaladOrders gso
                    INNER JOIN dbo.Salads s ON s.SaladID = gso.SaladID
                    LEFT JOIN dbo.Employees e ON e.EmployeeNo = gso.HostEmployeeNo
                    OUTER APPLY
                    (
                        SELECT SUM(sc.Quantity) AS Cancelled
                        FROM dbo.SaladOrderCancellations sc
                        WHERE sc.OrderType = N'Guest'
                          AND sc.GuestSaladOrderID = gso.GuestSaladOrderID
                    ) c
                    WHERE gso.MenuDate BETWEEN @dateFrom AND @dateTo
                      AND gso.Quantity - COALESCE(c.Cancelled, 0) > 0

                    ORDER BY MenuDate, ItemType, NameSV, OrderType;
                `);

            const orders = result.recordset.map(mapOrder);
            return {
                status: 200,
                jsonBody: {
                    dateFrom,
                    dateTo,
                    orders,
                    summary: {
                        orderRows: orders.length,
                        portions: sum(orders),
                        meals: sum(orders.filter(x => x.itemType === 'meal')),
                        salads: sum(orders.filter(x => x.itemType === 'salad'))
                    }
                }
            };
        } catch (error) {
            context.error('Kitchen orders request failed', error);
            return { status: 500, jsonBody: { error: 'Kitchen orders request failed', details: error.message } };
        }
    }
});

function mapOrder(row) {
    const quantity = Number(row.ActiveQuantity);
    return {
        itemType: row.ItemType,
        orderType: row.OrderType,
        orderId: row.OrderID,
        guestOrderId: row.GuestOrderID,
        saladOrderId: row.SaladOrderID,
        guestSaladOrderId: row.GuestSaladOrderID,
        menuDate: formatDate(row.MenuDate),
        employeeNo: row.EmployeeNo,
        employeeName: [row.FirstName, row.LastName].filter(Boolean).join(' ') || (row.EmployeeNo ? `Employee ${row.EmployeeNo}` : 'External account'),
        mealId: row.ItemType === 'salad' ? `S${row.ItemID}` : row.ItemID,
        saladId: row.ItemType === 'salad' ? row.ItemID : null,
        nameEN: row.NameEN,
        nameSV: row.NameSV,
        nameFI: row.NameFI,
        category: row.Category,
        quantity,
        activeQuantity: quantity,
        canCancel: quantity > 0,
        workTask: row.WorkTask || null,
        orderTime: row.OrderTime
    };
}
function sum(items) { return items.reduce((n, x) => n + Number(x.quantity || 0), 0); }
function formatDate(v) { return typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10); }
function isDate(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v); }
