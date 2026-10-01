const { app } = require('@azure/functions');
const sql = require('mssql');

app.http('orders', {
    methods: ['GET', 'PUT'],
    authLevel: 'anonymous',
    route: 'orders',

    handler: async (request, context) => {
        try {
            const pool = await sql.connect(process.env.SqlConnectionString);

            if (request.method === 'GET') {
                return await getOrders(pool, request, context);
            }

            if (request.method === 'PUT') {
                return await putOrders(pool, request, context);
            }

            return {
                status: 405,
                headers: { Allow: 'GET, PUT' },
                jsonBody: { error: 'Method not allowed' }
            };
        } catch (error) {
            context.error('Orders request failed', error);

            return {
                status: 500,
                jsonBody: {
                    error: 'Orders request failed',
                    details: error.message
                }
            };
        }
    }
});

async function getOrders(pool, request, context) {
    const url = new URL(request.url);
    const employeeNo = parsePositiveInteger(
        url.searchParams.get('employeeNo')
    );
    const dateFrom = parseIsoDate(url.searchParams.get('dateFrom'));
    const dateTo = parseIsoDate(url.searchParams.get('dateTo'));

    if (!employeeNo) {
        return badRequest('employeeNo must be a positive integer');
    }

    if (url.searchParams.get('dateFrom') && !dateFrom) {
        return badRequest('dateFrom must use YYYY-MM-DD format');
    }

    if (url.searchParams.get('dateTo') && !dateTo) {
        return badRequest('dateTo must use YYYY-MM-DD format');
    }

    if (dateFrom && dateTo && dateFrom > dateTo) {
        return badRequest('dateFrom cannot be later than dateTo');
    }

    context.log(`Reading orders for employee ${employeeNo}`);

    const dbRequest = pool.request()
        .input('employeeNo', sql.Int, employeeNo);

    const filters = ['o.EmployeeNo = @employeeNo'];

    if (dateFrom) {
        dbRequest.input('dateFrom', sql.Date, dateFrom);
        filters.push('o.MenuDate >= @dateFrom');
    }

    if (dateTo) {
        dbRequest.input('dateTo', sql.Date, dateTo);
        filters.push('o.MenuDate <= @dateTo');
    }

    const result = await dbRequest.query(`
        SELECT
            o.OrderID,
            o.EmployeeNo,
            o.MenuDate,
            o.OrderedMealID AS MealID,
            o.Quantity AS OriginalQuantity,
            COALESCE(oc.CancelledQuantity, 0) AS CancelledQuantity,
            o.Quantity - COALESCE(oc.CancelledQuantity, 0) AS Quantity,
            o.OrderTime,
            m.NameEN,
            m.NameSV,
            m.NameFI,
            m.Category
        FROM dbo.Orders o
        INNER JOIN dbo.Meals m
            ON m.MealID = o.OrderedMealID
        OUTER APPLY
        (
            SELECT SUM(c.Quantity) AS CancelledQuantity
            FROM dbo.OrderCancellations c
            WHERE c.OrderType = N'Employee'
              AND c.OrderID = o.OrderID
        ) oc
        WHERE ${filters.join('\n          AND ')}
          AND o.Quantity - COALESCE(oc.CancelledQuantity, 0) > 0
        ORDER BY
            o.MenuDate,
            CASE m.Category
                WHEN 'Main' THEN 1
                WHEN 'Vegetarian' THEN 2
                WHEN 'Soup' THEN 3
                WHEN 'Salad' THEN 4
                WHEN 'Dessert' THEN 5
                ELSE 6
            END,
            m.NameSV;
    `);

    return {
        status: 200,
        jsonBody: {
            employeeNo,
            dateFrom,
            dateTo,
            orders: result.recordset.map(row => ({
                orderId: row.OrderID,
                employeeNo: row.EmployeeNo,
                menuDate: formatSqlDate(row.MenuDate),
                mealId: row.MealID,
                quantity: row.Quantity,
                originalQuantity: row.OriginalQuantity,
                cancelledQuantity: Number(row.CancelledQuantity),
                activeQuantity: row.Quantity,
                orderTime: row.OrderTime,
                nameEN: row.NameEN,
                nameSV: row.NameSV,
                nameFI: row.NameFI,
                category: row.Category
            }))
        }
    };
}

async function putOrders(pool, request, context) {
    const bodyResult = await readJsonBody(request);

    if (bodyResult.error) {
        return bodyResult.error;
    }

    const validation = validatePutPayload(bodyResult.body);

    if (validation.error) {
        return badRequest(validation.error);
    }

    const payload = validation.payload;

    const employeeResult = await pool.request()
        .input('employeeNo', sql.Int, payload.employeeNo)
        .query(`
            SELECT EmployeeNo
            FROM dbo.Employees
            WHERE EmployeeNo = @employeeNo
              AND COALESCE(Active, 1) = 1;
        `);

    if (employeeResult.recordset.length === 0) {
        return {
            status: 400,
            jsonBody: {
                error: 'Employee does not exist or is inactive',
                employeeNo: payload.employeeNo
            }
        };
    }

    const distinctMealIds = [
        ...new Set(payload.orders.map(order => order.mealId))
    ];

    if (distinctMealIds.length > 0) {
        const mealRequest = pool.request();
        const parameters = distinctMealIds.map((mealId, index) => {
            const name = `mealId${index}`;
            mealRequest.input(name, sql.Int, mealId);
            return `@${name}`;
        });

        const mealResult = await mealRequest.query(`
            SELECT MealID
            FROM dbo.Meals
            WHERE MealID IN (${parameters.join(', ')});
        `);

        const existingMealIds = new Set(
            mealResult.recordset.map(row => row.MealID)
        );
        const missingMealIds = distinctMealIds.filter(
            mealId => !existingMealIds.has(mealId)
        );

        if (missingMealIds.length > 0) {
            return {
                status: 400,
                jsonBody: {
                    error: 'One or more submitted meals do not exist',
                    missingMealIds
                }
            };
        }
    }

    context.log(
        `Replacing orders for employee ${payload.employeeNo} between ` +
        `${payload.dateFrom} and ${payload.dateTo}`
    );

    const transaction = new sql.Transaction(pool);
    let transactionStarted = false;

    try {
        await transaction.begin();
        transactionStarted = true;

        const existingResult = await new sql.Request(transaction)
            .input('employeeNo', sql.Int, payload.employeeNo)
            .input('dateFrom', sql.Date, payload.dateFrom)
            .input('dateTo', sql.Date, payload.dateTo)
            .query(`
                SELECT
                    o.OrderID,
                    o.MenuDate,
                    o.OrderedMealID AS MealID,
                    COALESCE(SUM(c.Quantity), 0) AS CancelledQuantity
                FROM dbo.Orders o
                LEFT JOIN dbo.OrderCancellations c
                    ON c.OrderType = N'Employee'
                   AND c.OrderID = o.OrderID
                WHERE o.EmployeeNo = @employeeNo
                  AND o.MenuDate >= @dateFrom
                  AND o.MenuDate <= @dateTo
                GROUP BY o.OrderID, o.MenuDate, o.OrderedMealID;
            `);

        const desiredKeys = new Set(
            payload.orders.map(order => `${order.menuDate}|${order.mealId}`)
        );

        for (const existing of existingResult.recordset) {
            const menuDate = formatSqlDate(existing.MenuDate);
            const key = `${menuDate}|${existing.MealID}`;
            if (!desiredKeys.has(key) && Number(existing.CancelledQuantity) === 0) {
                await new sql.Request(transaction)
                    .input('orderId', sql.Int, existing.OrderID)
                    .query('DELETE FROM dbo.Orders WHERE OrderID = @orderId;');
            }
        }

        for (const order of payload.orders) {
            const existing = existingResult.recordset.find(row =>
                formatSqlDate(row.MenuDate) === order.menuDate &&
                Number(row.MealID) === order.mealId
            );

            if (existing) {
                await new sql.Request(transaction)
                    .input('orderId', sql.Int, existing.OrderID)
                    .input('quantity', sql.Int,
                        order.quantity + Number(existing.CancelledQuantity))
                    .query(`
                        UPDATE dbo.Orders
                        SET Quantity = @quantity,
                            OrderTime = SYSUTCDATETIME()
                        WHERE OrderID = @orderId;
                    `);
            } else {
                await new sql.Request(transaction)
                    .input('employeeNo', sql.Int, payload.employeeNo)
                    .input('menuDate', sql.Date, order.menuDate)
                    .input('mealId', sql.Int, order.mealId)
                    .input('quantity', sql.Int, order.quantity)
                    .query(`
                        INSERT INTO dbo.Orders
                            (EmployeeNo, MenuDate, OrderedMealID, Quantity)
                        VALUES
                            (@employeeNo, @menuDate, @mealId, @quantity);
                    `);
            }
        }

        await transaction.commit();
        transactionStarted = false;

        return {
            status: 200,
            jsonBody: {
                success: true,
                employeeNo: payload.employeeNo,
                dateFrom: payload.dateFrom,
                dateTo: payload.dateTo,
                orderLines: payload.orders.length,
                totalLunches: payload.orders.reduce(
                    (sum, order) => sum + order.quantity,
                    0
                )
            }
        };
    } catch (error) {
        if (transactionStarted) {
            try {
                await transaction.rollback();
            } catch (rollbackError) {
                context.error(
                    'Order transaction rollback failed',
                    rollbackError
                );
            }
        }

        throw error;
    }
}

function validatePutPayload(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { error: 'Request body must be a JSON object' };
    }

    const employeeNo = parsePositiveInteger(body.employeeNo);
    const dateFrom = parseIsoDate(body.dateFrom);
    const dateTo = parseIsoDate(body.dateTo);

    if (!employeeNo) {
        return { error: 'employeeNo must be a positive integer' };
    }

    if (!dateFrom || !dateTo) {
        return {
            error: 'dateFrom and dateTo must use YYYY-MM-DD format'
        };
    }

    if (dateFrom > dateTo) {
        return { error: 'dateFrom cannot be later than dateTo' };
    }

    if (!Array.isArray(body.orders)) {
        return { error: 'orders must be an array' };
    }

    const uniqueOrders = new Map();

    for (const order of body.orders) {
        if (!order || typeof order !== 'object' || Array.isArray(order)) {
            return { error: 'Every order must be an object' };
        }

        const menuDate = parseIsoDate(order.menuDate);
        const mealId = parsePositiveInteger(order.mealId);
        const quantity = parsePositiveInteger(order.quantity);

        if (!menuDate) {
            return {
                error: 'Every menuDate must use YYYY-MM-DD format'
            };
        }

        if (menuDate < dateFrom || menuDate > dateTo) {
            return {
                error: `Order date ${menuDate} is outside the replacement range`
            };
        }

        if (!mealId) {
            return { error: 'Every mealId must be a positive integer' };
        }

        if (!quantity || quantity > 50) {
            return {
                error: 'Every quantity must be an integer between 1 and 50'
            };
        }

        const key = `${menuDate}:${mealId}`;
        const existing = uniqueOrders.get(key);

        uniqueOrders.set(key, {
            menuDate,
            mealId,
            quantity: (existing?.quantity || 0) + quantity
        });
    }

    const orders = [...uniqueOrders.values()];

    if (orders.some(order => order.quantity > 50)) {
        return {
            error: 'Combined quantity for one meal and date cannot exceed 50'
        };
    }

    return {
        payload: {
            employeeNo,
            dateFrom,
            dateTo,
            orders
        }
    };
}

function parsePositiveInteger(value) {
    if (typeof value === 'number') {
        return Number.isInteger(value) && value > 0 ? value : null;
    }

    if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
        return null;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseIsoDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return null;
    }

    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));

    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    ) {
        return null;
    }

    return value;
}

function formatSqlDate(value) {
    if (value instanceof Date) {
        return value.toISOString().slice(0, 10);
    }

    return String(value).slice(0, 10);
}

async function readJsonBody(request) {
    try {
        return { body: await request.json() };
    } catch {
        return {
            error: {
                status: 400,
                jsonBody: {
                    error: 'Request body must contain valid JSON'
                }
            }
        };
    }
}

function badRequest(message) {
    return {
        status: 400,
        jsonBody: { error: message }
    };
}
