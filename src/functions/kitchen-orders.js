const { app } = require('@azure/functions');
const sql = require('mssql');

const MAX_RANGE_DAYS = 366;

app.http('kitchen-orders', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'kitchen/orders',
    handler: async (request, context) => {
        const dateFrom = request.query.get('dateFrom');
        const dateTo = request.query.get('dateTo');

        if (!isIsoDate(dateFrom) || !isIsoDate(dateTo)) {
            return badRequest('dateFrom and dateTo are required and must use YYYY-MM-DD format');
        }
        if (dateFrom > dateTo) {
            return badRequest('dateFrom cannot be later than dateTo');
        }
        if (daysBetween(dateFrom, dateTo) + 1 > MAX_RANGE_DAYS) {
            return badRequest(`Date range cannot exceed ${MAX_RANGE_DAYS} days`);
        }

        try {
            const pool = await sql.connect(process.env.SqlConnectionString);
            const result = await pool.request()
                .input('dateFrom', sql.Date, dateFrom)
                .input('dateTo', sql.Date, dateTo)
                .query(`
                    WITH EmployeeCancellations AS
                    (
                        SELECT
                            OrderID,
                            SUM(Quantity) AS CancelledQuantity
                        FROM dbo.OrderCancellations
                        WHERE OrderType = N'Employee'
                        GROUP BY OrderID
                    ),
                    GuestCancellations AS
                    (
                        SELECT
                            GuestOrderID,
                            SUM(Quantity) AS CancelledQuantity
                        FROM dbo.OrderCancellations
                        WHERE OrderType = N'Guest'
                        GROUP BY GuestOrderID
                    )
                    SELECT
                        N'employee' AS OrderType,
                        o.OrderID,
                        CAST(NULL AS INT) AS GuestOrderID,
                        o.MenuDate,
                        o.EmployeeNo,
                        e.FirstName,
                        e.LastName,
                        o.OrderedMealID AS MealID,
                        m.NameEN,
                        m.NameSV,
                        m.NameFI,
                        m.Category,
                        o.Quantity AS OriginalQuantity,
                        COALESCE(ec.CancelledQuantity, 0) AS CancelledQuantity,
                        o.Quantity - COALESCE(ec.CancelledQuantity, 0) AS ActiveQuantity,
                        CAST(NULL AS NVARCHAR(255)) AS WorkTask,
                        o.OrderTime
                    FROM dbo.Orders o
                    LEFT JOIN dbo.Employees e
                        ON e.EmployeeNo = o.EmployeeNo
                    INNER JOIN dbo.Meals m
                        ON m.MealID = o.OrderedMealID
                    LEFT JOIN EmployeeCancellations ec
                        ON ec.OrderID = o.OrderID
                    WHERE o.MenuDate >= @dateFrom
                      AND o.MenuDate <= @dateTo
                      AND o.Quantity - COALESCE(ec.CancelledQuantity, 0) > 0

                    UNION ALL

                    SELECT
                        N'guest' AS OrderType,
                        CAST(NULL AS INT) AS OrderID,
                        go.GuestOrderID,
                        go.MenuDate,
                        go.HostEmployeeNo AS EmployeeNo,
                        e.FirstName,
                        e.LastName,
                        go.OrderedMealID AS MealID,
                        m.NameEN,
                        m.NameSV,
                        m.NameFI,
                        m.Category,
                        go.Quantity AS OriginalQuantity,
                        COALESCE(gc.CancelledQuantity, 0) AS CancelledQuantity,
                        go.Quantity - COALESCE(gc.CancelledQuantity, 0) AS ActiveQuantity,
                        go.WorkTask,
                        go.OrderTime
                    FROM dbo.GuestOrders go
                    LEFT JOIN dbo.Employees e
                        ON e.EmployeeNo = go.HostEmployeeNo
                    INNER JOIN dbo.Meals m
                        ON m.MealID = go.OrderedMealID
                    LEFT JOIN GuestCancellations gc
                        ON gc.GuestOrderID = go.GuestOrderID
                    WHERE go.MenuDate >= @dateFrom
                      AND go.MenuDate <= @dateTo
                      AND go.Quantity - COALESCE(gc.CancelledQuantity, 0) > 0

                    ORDER BY
                        MenuDate,
                        Category,
                        NameSV,
                        OrderType,
                        EmployeeNo;
                `);

            const orders = result.recordset.map(mapOrder);
            const employeeOrders = orders.filter(order => order.orderType === 'employee');
            const guestOrders = orders.filter(order => order.orderType === 'guest');

            return {
                status: 200,
                jsonBody: {
                    dateFrom,
                    dateTo,
                    generatedAt: new Date().toISOString(),
                    summary: {
                        orderRows: orders.length,
                        totalPortions: sumActiveQuantity(orders),
                        employeePortions: sumActiveQuantity(employeeOrders),
                        guestPortions: sumActiveQuantity(guestOrders),
                        cancelledPortions: orders.reduce(
                            (total, order) => total + order.cancelledQuantity,
                            0
                        ),
                        uniqueEmployees: new Set(
                            employeeOrders.map(order => order.employeeNo)
                        ).size,
                        uniqueHosts: new Set(
                            guestOrders.map(order => order.employeeNo)
                        ).size
                    },
                    orders
                }
            };
        } catch (error) {
            context.error('Kitchen orders request failed', error);
            return {
                status: 500,
                jsonBody: {
                    error: 'Kitchen orders request failed',
                    details: error.message
                }
            };
        }
    }
});

function mapOrder(row) {
    const originalQuantity = Number(row.OriginalQuantity);
    const cancelledQuantity = Number(row.CancelledQuantity);
    const activeQuantity = Number(row.ActiveQuantity);

    return {
        orderType: row.OrderType,
        orderId: row.OrderID,
        guestOrderId: row.GuestOrderID,
        menuDate: formatSqlDate(row.MenuDate),
        employeeNo: row.EmployeeNo,
        employeeName: [row.FirstName, row.LastName]
            .filter(Boolean)
            .join(' ') || `Employee ${row.EmployeeNo}`,
        mealId: row.MealID,
        nameEN: row.NameEN,
        nameSV: row.NameSV,
        nameFI: row.NameFI,
        category: row.Category,
        quantity: activeQuantity,
        originalQuantity,
        cancelledQuantity,
        activeQuantity,
        canCancel: activeQuantity > 0,
        workTask: row.WorkTask || null,
        orderTime: row.OrderTime
    };
}

function sumActiveQuantity(orders) {
    return orders.reduce((total, order) => total + order.activeQuantity, 0);
}

function formatSqlDate(value) {
    if (typeof value === 'string') return value.slice(0, 10);
    return value.toISOString().slice(0, 10);
}

function isIsoDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function daysBetween(fromDate, toDate) {
    return Math.floor(
        (Date.parse(`${toDate}T00:00:00Z`) -
         Date.parse(`${fromDate}T00:00:00Z`)) / 86400000
    );
}

function badRequest(message) {
    return { status: 400, jsonBody: { error: message } };
}
