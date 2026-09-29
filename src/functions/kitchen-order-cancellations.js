const { app } = require('@azure/functions');
const sql = require('mssql');

const REASON_CODES = new Set([
    'INSUFFICIENT_PORTIONS',
    'EMPLOYEE_REQUEST',
    'EMPLOYEE_ABSENT',
    'WRONG_DISH',
    'KITCHEN_CORRECTION',
    'OTHER'
]);

app.http('kitchen-order-cancellations', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'kitchen/order-cancellations',
    handler: async (request, context) => {
        let body;
        try {
            body = await request.json();
        } catch {
            return badRequest('Request body must contain valid JSON');
        }

        const validation = validateRequest(body);
        if (validation.error) return badRequest(validation.error);

        const cancellation = validation.value;

        try {
            const pool = await sql.connect(process.env.SqlConnectionString);
            return await createCancellation(pool, cancellation, context);
        } catch (error) {
            context.error('Kitchen order cancellation failed', error);
            return {
                status: 500,
                jsonBody: {
                    error: 'Kitchen order cancellation failed',
                    details: error.message
                }
            };
        }
    }
});

async function createCancellation(pool, cancellation, context) {
    const transaction = new sql.Transaction(pool);
    let transactionStarted = false;

    try {
        await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
        transactionStarted = true;

        const order = cancellation.orderType === 'Employee'
            ? await getEmployeeOrder(transaction, cancellation.orderId)
            : await getGuestOrder(transaction, cancellation.guestOrderId);

        if (!order) {
            await transaction.rollback();
            transactionStarted = false;
            return {
                status: 404,
                jsonBody: {
                    error: cancellation.orderType === 'Employee'
                        ? `Employee order ${cancellation.orderId} does not exist`
                        : `Guest order ${cancellation.guestOrderId} does not exist`
                }
            };
        }

        const previouslyCancelled = await getCancelledQuantity(
            transaction,
            cancellation.orderType,
            cancellation.orderId,
            cancellation.guestOrderId
        );

        const originalQuantity = Number(order.Quantity);
        const availableQuantity = originalQuantity - previouslyCancelled;

        if (availableQuantity <= 0) {
            await transaction.rollback();
            transactionStarted = false;
            return {
                status: 409,
                jsonBody: {
                    error: 'This order has already been fully cancelled',
                    originalQuantity,
                    cancelledQuantity: previouslyCancelled,
                    activeQuantity: 0
                }
            };
        }

        if (cancellation.quantity > availableQuantity) {
            await transaction.rollback();
            transactionStarted = false;
            return {
                status: 409,
                jsonBody: {
                    error: 'Cancellation quantity exceeds the active order quantity',
                    requestedQuantity: cancellation.quantity,
                    originalQuantity,
                    cancelledQuantity: previouslyCancelled,
                    activeQuantity: availableQuantity
                }
            };
        }

        const insertResult = await new sql.Request(transaction)
            .input('orderType', sql.NVarChar(20), cancellation.orderType)
            .input('orderId', sql.Int, cancellation.orderId)
            .input('guestOrderId', sql.Int, cancellation.guestOrderId)
            .input('quantity', sql.Int, cancellation.quantity)
            .input('reasonCode', sql.NVarChar(50), cancellation.reasonCode)
            .input('reasonText', sql.NVarChar(500), cancellation.reasonText)
            .input('cancelledBy', sql.NVarChar(100), cancellation.cancelledBy)
            .query(`
                INSERT INTO dbo.OrderCancellations
                (
                    OrderType,
                    OrderID,
                    GuestOrderID,
                    Quantity,
                    ReasonCode,
                    ReasonText,
                    CancelledBy
                )
                OUTPUT
                    INSERTED.OrderCancellationID,
                    INSERTED.CancelledAt
                VALUES
                (
                    @orderType,
                    @orderId,
                    @guestOrderId,
                    @quantity,
                    @reasonCode,
                    @reasonText,
                    @cancelledBy
                );
            `);

        await transaction.commit();
        transactionStarted = false;

        const totalCancelledQuantity = previouslyCancelled + cancellation.quantity;
        const activeQuantity = originalQuantity - totalCancelledQuantity;
        const inserted = insertResult.recordset[0];

        context.log(
            `Cancelled ${cancellation.quantity} portion(s) from ` +
            `${cancellation.orderType} order ${order.SourceOrderID}`
        );

        return {
            status: 201,
            jsonBody: {
                orderCancellationId: inserted.OrderCancellationID,
                orderType: cancellation.orderType.toLowerCase(),
                orderId: cancellation.orderType === 'Employee'
                    ? cancellation.orderId
                    : null,
                guestOrderId: cancellation.orderType === 'Guest'
                    ? cancellation.guestOrderId
                    : null,
                menuDate: formatSqlDate(order.MenuDate),
                employeeNo: order.EmployeeNo,
                employeeName: [order.FirstName, order.LastName]
                    .filter(Boolean)
                    .join(' ') || `Employee ${order.EmployeeNo}`,
                mealId: order.MealID,
                mealName: order.NameEN || order.NameSV || order.NameFI || `Meal ${order.MealID}`,
                originalQuantity,
                cancelledQuantity: totalCancelledQuantity,
                activeQuantity,
                reasonCode: cancellation.reasonCode,
                reasonText: cancellation.reasonText,
                cancelledBy: cancellation.cancelledBy,
                cancelledAt: inserted.CancelledAt
            }
        };
    } catch (error) {
        if (transactionStarted) {
            try {
                await transaction.rollback();
            } catch (rollbackError) {
                context.error('Cancellation rollback failed', rollbackError);
            }
        }
        throw error;
    }
}

async function getEmployeeOrder(transaction, orderId) {
    const result = await new sql.Request(transaction)
        .input('orderId', sql.Int, orderId)
        .query(`
            SELECT
                o.OrderID AS SourceOrderID,
                o.EmployeeNo,
                o.MenuDate,
                o.OrderedMealID AS MealID,
                o.Quantity,
                e.FirstName,
                e.LastName,
                m.NameEN,
                m.NameSV,
                m.NameFI
            FROM dbo.Orders o WITH (UPDLOCK, HOLDLOCK)
            LEFT JOIN dbo.Employees e
                ON e.EmployeeNo = o.EmployeeNo
            INNER JOIN dbo.Meals m
                ON m.MealID = o.OrderedMealID
            WHERE o.OrderID = @orderId;
        `);

    return result.recordset[0] || null;
}

async function getGuestOrder(transaction, guestOrderId) {
    const result = await new sql.Request(transaction)
        .input('guestOrderId', sql.Int, guestOrderId)
        .query(`
            SELECT
                go.GuestOrderID AS SourceOrderID,
                go.HostEmployeeNo AS EmployeeNo,
                go.MenuDate,
                go.OrderedMealID AS MealID,
                go.Quantity,
                e.FirstName,
                e.LastName,
                m.NameEN,
                m.NameSV,
                m.NameFI
            FROM dbo.GuestOrders go WITH (UPDLOCK, HOLDLOCK)
            LEFT JOIN dbo.Employees e
                ON e.EmployeeNo = go.HostEmployeeNo
            INNER JOIN dbo.Meals m
                ON m.MealID = go.OrderedMealID
            WHERE go.GuestOrderID = @guestOrderId;
        `);

    return result.recordset[0] || null;
}

async function getCancelledQuantity(
    transaction,
    orderType,
    orderId,
    guestOrderId
) {
    const result = await new sql.Request(transaction)
        .input('orderType', sql.NVarChar(20), orderType)
        .input('orderId', sql.Int, orderId)
        .input('guestOrderId', sql.Int, guestOrderId)
        .query(`
            SELECT COALESCE(SUM(Quantity), 0) AS CancelledQuantity
            FROM dbo.OrderCancellations WITH (UPDLOCK, HOLDLOCK)
            WHERE OrderType = @orderType
              AND
              (
                  (@orderType = N'Employee' AND OrderID = @orderId)
                  OR
                  (@orderType = N'Guest' AND GuestOrderID = @guestOrderId)
              );
        `);

    return Number(result.recordset[0].CancelledQuantity);
}

function validateRequest(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { error: 'Request body must be a JSON object' };
    }

    const normalisedType = String(body.orderType || '').trim().toLowerCase();
    const orderType = normalisedType === 'employee'
        ? 'Employee'
        : normalisedType === 'guest'
            ? 'Guest'
            : null;

    if (!orderType) {
        return { error: 'orderType must be employee or guest' };
    }

    const orderId = parsePositiveInteger(body.orderId);
    const guestOrderId = parsePositiveInteger(body.guestOrderId);

    if (orderType === 'Employee' && !orderId) {
        return { error: 'orderId is required for an employee cancellation' };
    }

    if (orderType === 'Employee' && body.guestOrderId != null) {
        return { error: 'guestOrderId must not be supplied for an employee cancellation' };
    }

    if (orderType === 'Guest' && !guestOrderId) {
        return { error: 'guestOrderId is required for a guest cancellation' };
    }

    if (orderType === 'Guest' && body.orderId != null) {
        return { error: 'orderId must not be supplied for a guest cancellation' };
    }

    const quantity = body.quantity === undefined
        ? 1
        : parsePositiveInteger(body.quantity);

    if (!quantity) {
        return { error: 'quantity must be a positive integer' };
    }

    const reasonCode = String(body.reasonCode || '').trim().toUpperCase();
    if (!REASON_CODES.has(reasonCode)) {
        return {
            error:
                'reasonCode must be INSUFFICIENT_PORTIONS, EMPLOYEE_REQUEST, ' +
                'EMPLOYEE_ABSENT, WRONG_DISH, KITCHEN_CORRECTION or OTHER'
        };
    }

    const reasonText = body.reasonText == null
        ? null
        : String(body.reasonText).trim() || null;

    if (reasonText && reasonText.length > 500) {
        return { error: 'reasonText must not exceed 500 characters' };
    }

    if (reasonCode === 'OTHER' && !reasonText) {
        return { error: 'reasonText is required when reasonCode is OTHER' };
    }

    const cancelledBy = String(body.cancelledBy || '').trim();
    if (!cancelledBy) {
        return { error: 'cancelledBy is required' };
    }

    if (cancelledBy.length > 100) {
        return { error: 'cancelledBy must not exceed 100 characters' };
    }

    return {
        value: {
            orderType,
            orderId: orderType === 'Employee' ? orderId : null,
            guestOrderId: orderType === 'Guest' ? guestOrderId : null,
            quantity,
            reasonCode,
            reasonText,
            cancelledBy
        }
    };
}

function parsePositiveInteger(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function formatSqlDate(value) {
    if (typeof value === 'string') return value.slice(0, 10);
    return value.toISOString().slice(0, 10);
}

function badRequest(message) {
    return {
        status: 400,
        jsonBody: { error: message }
    };
}
