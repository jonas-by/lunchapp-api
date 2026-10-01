const { app } = require('@azure/functions');
const sql = require('mssql');

app.http('guest-orders', {
    methods: ['GET', 'PUT'],
    authLevel: 'anonymous',
    route: 'guest-orders',

    handler: async (request, context) => {
        try {
            const pool = await sql.connect(process.env.SqlConnectionString);

            if (request.method === 'GET') {
                return await getGuestOrders(pool, request, context);
            }

            if (request.method === 'PUT') {
                return await putGuestOrders(pool, request, context);
            }

            return {
                status: 405,
                headers: { Allow: 'GET, PUT' },
                jsonBody: { error: 'Method not allowed' }
            };
        } catch (error) {
            context.error('Guest orders request failed', error);

            return {
                status: 500,
                jsonBody: {
                    error: 'Guest orders request failed',
                    details: error.message
                }
            };
        }
    }
});

async function getGuestOrders(pool, request, context) {
    const url = new URL(request.url);
    const hostEmployeeNo = parsePositiveInteger(
        url.searchParams.get('hostEmployeeNo')
    );
    const dateFrom = parseIsoDate(url.searchParams.get('dateFrom'));
    const dateTo = parseIsoDate(url.searchParams.get('dateTo'));

    if (!hostEmployeeNo) {
        return badRequest('hostEmployeeNo must be a positive integer');
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

    context.log(`Reading guest orders for host employee ${hostEmployeeNo}`);

    const dbRequest = pool.request()
        .input('hostEmployeeNo', sql.Int, hostEmployeeNo);

    const filters = ['go.HostEmployeeNo = @hostEmployeeNo'];

    if (dateFrom) {
        dbRequest.input('dateFrom', sql.Date, dateFrom);
        filters.push('go.MenuDate >= @dateFrom');
    }

    if (dateTo) {
        dbRequest.input('dateTo', sql.Date, dateTo);
        filters.push('go.MenuDate <= @dateTo');
    }

    const result = await dbRequest.query(`
        SELECT
            go.GuestOrderID,
            go.HostEmployeeNo,
            go.MenuDate,
            go.OrderedMealID AS MealID,
            go.Quantity AS OriginalQuantity,
            COALESCE(oc.CancelledQuantity, 0) AS CancelledQuantity,
            go.Quantity - COALESCE(oc.CancelledQuantity, 0) AS Quantity,
            go.WorkTask,
            go.OrderTime,
            m.NameEN,
            m.NameSV,
            m.NameFI,
            m.Category
        FROM dbo.GuestOrders go
        INNER JOIN dbo.Meals m
            ON m.MealID = go.OrderedMealID
        OUTER APPLY
        (
            SELECT SUM(c.Quantity) AS CancelledQuantity
            FROM dbo.OrderCancellations c
            WHERE c.OrderType = N'Guest'
              AND c.GuestOrderID = go.GuestOrderID
        ) oc
        WHERE ${filters.join('\n          AND ')}
          AND go.Quantity - COALESCE(oc.CancelledQuantity, 0) > 0
        ORDER BY
            go.MenuDate,
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
            hostEmployeeNo,
            dateFrom,
            dateTo,
            orders: result.recordset.map(row => ({
                guestOrderId: row.GuestOrderID,
                hostEmployeeNo: row.HostEmployeeNo,
                menuDate: formatSqlDate(row.MenuDate),
                mealId: row.MealID,
                quantity: row.Quantity,
                originalQuantity: row.OriginalQuantity,
                cancelledQuantity: Number(row.CancelledQuantity),
                activeQuantity: row.Quantity,
                workTask: row.WorkTask,
                orderTime: row.OrderTime,
                nameEN: row.NameEN,
                nameSV: row.NameSV,
                nameFI: row.NameFI,
                category: row.Category
            }))
        }
    };
}

async function putGuestOrders(pool, request, context) {
    const bodyResult = await readJsonBody(request);

    if (bodyResult.error) {
        return bodyResult.error;
    }

    const validation = validatePutPayload(bodyResult.body);

    if (validation.error) {
        return badRequest(validation.error);
    }

    const payload = validation.payload;

    const hostResult = await pool.request()
        .input('hostEmployeeNo', sql.Int, payload.hostEmployeeNo)
        .query(`
            SELECT EmployeeNo
            FROM dbo.Employees
            WHERE EmployeeNo = @hostEmployeeNo
              AND Active = 1;
        `);

    if (hostResult.recordset.length === 0) {
        return {
            status: 400,
            jsonBody: {
                error: 'Host employee does not exist or is inactive',
                hostEmployeeNo: payload.hostEmployeeNo
            }
        };
    }

    const distinctMealIds = [
        ...new Set(payload.orders.map(order => order.mealId))
    ];

    if (distinctMealIds.length > 0) {
        const mealRequest = pool.request();
        const parameters = distinctMealIds.map((mealId, index) => {
            const parameterName = `mealId${index}`;
            mealRequest.input(parameterName, sql.Int, mealId);
            return `@${parameterName}`;
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
        `Replacing guest orders for host ${payload.hostEmployeeNo} ` +
        `between ${payload.dateFrom} and ${payload.dateTo}`
    );

    const transaction = new sql.Transaction(pool);
    let transactionStarted = false;

    try {
        await transaction.begin();
        transactionStarted = true;

        const existingResult = await new sql.Request(transaction)
            .input('hostEmployeeNo', sql.Int, payload.hostEmployeeNo)
            .input('dateFrom', sql.Date, payload.dateFrom)
            .input('dateTo', sql.Date, payload.dateTo)
            .query(`
                SELECT
                    go.GuestOrderID,
                    go.MenuDate,
                    go.OrderedMealID AS MealID,
                    COALESCE(SUM(c.Quantity), 0) AS CancelledQuantity
                FROM dbo.GuestOrders go
                LEFT JOIN dbo.OrderCancellations c
                    ON c.OrderType = N'Guest'
                   AND c.GuestOrderID = go.GuestOrderID
                WHERE go.HostEmployeeNo = @hostEmployeeNo
                  AND go.MenuDate >= @dateFrom
                  AND go.MenuDate <= @dateTo
                GROUP BY go.GuestOrderID, go.MenuDate, go.OrderedMealID;
            `);

        const desiredKeys = new Set(
            payload.orders.map(order => `${order.menuDate}|${order.mealId}`)
        );

        for (const existing of existingResult.recordset) {
            const menuDate = formatSqlDate(existing.MenuDate);
            const key = `${menuDate}|${existing.MealID}`;
            if (!desiredKeys.has(key) && Number(existing.CancelledQuantity) === 0) {
                await new sql.Request(transaction)
                    .input('guestOrderId', sql.Int, existing.GuestOrderID)
                    .query('DELETE FROM dbo.GuestOrders WHERE GuestOrderID = @guestOrderId;');
            }
        }

        for (const order of payload.orders) {
            const existing = existingResult.recordset.find(row =>
                formatSqlDate(row.MenuDate) === order.menuDate &&
                Number(row.MealID) === order.mealId
            );

            if (existing) {
                await new sql.Request(transaction)
                    .input('guestOrderId', sql.Int, existing.GuestOrderID)
                    .input('quantity', sql.Int,
                        order.quantity + Number(existing.CancelledQuantity))
                    .input('workTask', sql.NVarChar(200), order.workTask)
                    .query(`
                        UPDATE dbo.GuestOrders
                        SET Quantity = @quantity,
                            WorkTask = @workTask,
                            OrderTime = SYSUTCDATETIME()
                        WHERE GuestOrderID = @guestOrderId;
                    `);
            } else {
                await new sql.Request(transaction)
                    .input('hostEmployeeNo', sql.Int, payload.hostEmployeeNo)
                    .input('menuDate', sql.Date, order.menuDate)
                    .input('mealId', sql.Int, order.mealId)
                    .input('quantity', sql.Int, order.quantity)
                    .input('workTask', sql.NVarChar(200), order.workTask)
                    .query(`
                        INSERT INTO dbo.GuestOrders
                            (HostEmployeeNo, MenuDate, OrderedMealID, Quantity, WorkTask)
                        VALUES
                            (@hostEmployeeNo, @menuDate, @mealId, @quantity, @workTask);
                    `);
            }
        }

        await transaction.commit();
        transactionStarted = false;

        return {
            status: 200,
            jsonBody: {
                success: true,
                hostEmployeeNo: payload.hostEmployeeNo,
                dateFrom: payload.dateFrom,
                dateTo: payload.dateTo,
                orderLines: payload.orders.length,
                totalGuestLunches: payload.orders.reduce(
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
                    'Guest order transaction rollback failed',
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

    const hostEmployeeNo = parsePositiveInteger(body.hostEmployeeNo);
    const dateFrom = parseIsoDate(body.dateFrom);
    const dateTo = parseIsoDate(body.dateTo);

    if (!hostEmployeeNo) {
        return { error: 'hostEmployeeNo must be a positive integer' };
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
        const workTask = typeof order.workTask === 'string'
            ? order.workTask.trim()
            : '';

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

        if (!quantity || quantity > 100) {
            return {
                error: 'Every quantity must be an integer between 1 and 100'
            };
        }

        if (!workTask) {
            return { error: 'Every guest order must include workTask' };
        }

        if (workTask.length > 200) {
            return {
                error: 'workTask cannot exceed 200 characters'
            };
        }

        const key = `${menuDate}:${mealId}:${workTask.toLowerCase()}`;
        const existing = uniqueOrders.get(key);

        uniqueOrders.set(key, {
            menuDate,
            mealId,
            quantity: (existing?.quantity || 0) + quantity,
            workTask
        });
    }

    const orders = [...uniqueOrders.values()];

    if (orders.some(order => order.quantity > 100)) {
        return {
            error: 'Combined quantity for one guest order cannot exceed 100'
        };
    }

    return {
        payload: {
            hostEmployeeNo,
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
