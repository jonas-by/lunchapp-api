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

        const rangeDays = daysBetween(dateFrom, dateTo) + 1;
        if (rangeDays > MAX_RANGE_DAYS) {
            return badRequest(`Date range cannot exceed ${MAX_RANGE_DAYS} days`);
        }

        try {
            const pool = await sql.connect(process.env.SqlConnectionString);
            const result = await pool.request()
                .input('dateFrom', sql.Date, dateFrom)
                .input('dateTo', sql.Date, dateTo)
                .query(`
                    SELECT
                        N'employee' AS OrderType,
                        o.OrderID,
                        o.MenuDate,
                        o.EmployeeNo,
                        e.FirstName,
                        e.LastName,
                        o.OrderedMealID AS MealID,
                        m.NameEN,
                        m.NameSV,
                        m.NameFI,
                        m.Category,
                        o.Quantity,
                        CAST(NULL AS NVARCHAR(255)) AS WorkTask,
                        o.OrderTime
                    FROM dbo.Orders o
                    LEFT JOIN dbo.Employees e
                        ON e.EmployeeNo = o.EmployeeNo
                    INNER JOIN dbo.Meals m
                        ON m.MealID = o.OrderedMealID
                    WHERE o.MenuDate >= @dateFrom
                      AND o.MenuDate <= @dateTo

                    UNION ALL

                    SELECT
                        N'guest' AS OrderType,
                        go.GuestOrderID AS OrderID,
                        go.MenuDate,
                        go.HostEmployeeNo AS EmployeeNo,
                        e.FirstName,
                        e.LastName,
                        go.OrderedMealID AS MealID,
                        m.NameEN,
                        m.NameSV,
                        m.NameFI,
                        m.Category,
                        go.Quantity,
                        go.WorkTask,
                        go.OrderTime
                    FROM dbo.GuestOrders go
                    LEFT JOIN dbo.Employees e
                        ON e.EmployeeNo = go.HostEmployeeNo
                    INNER JOIN dbo.Meals m
                        ON m.MealID = go.OrderedMealID
                    WHERE go.MenuDate >= @dateFrom
                      AND go.MenuDate <= @dateTo

                    ORDER BY
                        MenuDate,
                        CASE Category
                            WHEN 'Main' THEN 1
                            WHEN 'Vegetarian' THEN 2
                            WHEN 'Soup' THEN 3
                            WHEN 'Salad' THEN 4
                            WHEN 'Dessert' THEN 5
                            ELSE 6
                        END,
                        NameSV,
                        OrderType,
                        EmployeeNo;
                `);

            const orders = result.recordset.map(mapOrder);
            const employeeOrders = orders.filter(order => order.orderType === 'employee');
            const guestOrders = orders.filter(order => order.orderType === 'guest');

            context.log(
                `Kitchen report ${dateFrom} to ${dateTo}: ` +
                `${orders.length} rows, ${sumQuantity(orders)} portions`
            );

            return {
                status: 200,
                jsonBody: {
                    dateFrom,
                    dateTo,
                    generatedAt: new Date().toISOString(),
                    summary: {
                        orderRows: orders.length,
                        totalPortions: sumQuantity(orders),
                        employeePortions: sumQuantity(employeeOrders),
                        guestPortions: sumQuantity(guestOrders),
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
    const employeeName = [row.FirstName, row.LastName]
        .filter(Boolean)
        .join(' ') || `Employee ${row.EmployeeNo}`;

    return {
        orderType: row.OrderType,
        orderId: row.OrderID,
        menuDate: formatSqlDate(row.MenuDate),
        employeeNo: row.EmployeeNo,
        employeeName,
        mealId: row.MealID,
        nameEN: row.NameEN,
        nameSV: row.NameSV,
        nameFI: row.NameFI,
        category: row.Category,
        quantity: Number(row.Quantity),
        workTask: row.WorkTask || null,
        orderTime: row.OrderTime
    };
}

function sumQuantity(orders) {
    return orders.reduce((total, order) => total + order.quantity, 0);
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
    return {
        status: 400,
        jsonBody: { error: message }
    };
}
