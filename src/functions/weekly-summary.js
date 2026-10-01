const { app } = require('@azure/functions');
const sql = require('mssql');

app.http('kitchen-weekly-summary', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'kitchen/weekly-summary',
    handler: async (request, context) => {
        const week = request.query.get('week');
        const weekRange = getIsoWeekRange(week);

        if (!weekRange) {
            return badRequest('week is required and must use YYYY-Www format, for example 2026-W40');
        }

        const { weekStart, weekEnd } = weekRange;

        try {
            const pool = await sql.connect(process.env.SqlConnectionString);
            const result = await pool.request()
                .input('weekStart', sql.Date, weekStart)
                .input('weekEnd', sql.Date, weekEnd)
                .query(`
                    WITH DailyOrders AS
                    (
                        SELECT
                            o.MenuDate,
                            SUM(o.Quantity) AS OrderedQuantity
                        FROM dbo.Orders o
                        WHERE o.MenuDate >= @weekStart
                          AND o.MenuDate <= @weekEnd
                        GROUP BY o.MenuDate

                        UNION ALL

                        SELECT
                            go.MenuDate,
                            SUM(go.Quantity) AS OrderedQuantity
                        FROM dbo.GuestOrders go
                        WHERE go.MenuDate >= @weekStart
                          AND go.MenuDate <= @weekEnd
                        GROUP BY go.MenuDate
                    ),
                    DailyCancellations AS
                    (
                        SELECT
                            o.MenuDate,
                            SUM(oc.Quantity) AS CancelledQuantity
                        FROM dbo.OrderCancellations oc
                        INNER JOIN dbo.Orders o
                            ON oc.OrderType = N'Employee'
                           AND oc.OrderID = o.OrderID
                        WHERE o.MenuDate >= @weekStart
                          AND o.MenuDate <= @weekEnd
                        GROUP BY o.MenuDate

                        UNION ALL

                        SELECT
                            go.MenuDate,
                            SUM(oc.Quantity) AS CancelledQuantity
                        FROM dbo.OrderCancellations oc
                        INNER JOIN dbo.GuestOrders go
                            ON oc.OrderType = N'Guest'
                           AND oc.GuestOrderID = go.GuestOrderID
                        WHERE go.MenuDate >= @weekStart
                          AND go.MenuDate <= @weekEnd
                        GROUP BY go.MenuDate
                    ),
                    OrdersByDate AS
                    (
                        SELECT
                            MenuDate,
                            SUM(OrderedQuantity) AS OrderedQuantity
                        FROM DailyOrders
                        GROUP BY MenuDate
                    ),
                    CancellationsByDate AS
                    (
                        SELECT
                            MenuDate,
                            SUM(CancelledQuantity) AS CancelledQuantity
                        FROM DailyCancellations
                        GROUP BY MenuDate
                    ),
                    SummaryDates AS
                    (
                        SELECT MenuDate FROM OrdersByDate
                        UNION
                        SELECT MenuDate FROM CancellationsByDate
                    )
                    SELECT
                        d.MenuDate,
                        COALESCE(o.OrderedQuantity, 0) AS OrderedQuantity,
                        COALESCE(c.CancelledQuantity, 0) AS CancelledQuantity,
                        COALESCE(o.OrderedQuantity, 0) - COALESCE(c.CancelledQuantity, 0) AS ServedQuantity
                    FROM SummaryDates d
                    LEFT JOIN OrdersByDate o
                        ON o.MenuDate = d.MenuDate
                    LEFT JOIN CancellationsByDate c
                        ON c.MenuDate = d.MenuDate
                    ORDER BY d.MenuDate;

                    WITH WeekCancellations AS
                    (
                        SELECT
                            oc.ReasonCode,
                            oc.Quantity
                        FROM dbo.OrderCancellations oc
                        INNER JOIN dbo.Orders o
                            ON oc.OrderType = N'Employee'
                           AND oc.OrderID = o.OrderID
                        WHERE o.MenuDate >= @weekStart
                          AND o.MenuDate <= @weekEnd

                        UNION ALL

                        SELECT
                            oc.ReasonCode,
                            oc.Quantity
                        FROM dbo.OrderCancellations oc
                        INNER JOIN dbo.GuestOrders go
                            ON oc.OrderType = N'Guest'
                           AND oc.GuestOrderID = go.GuestOrderID
                        WHERE go.MenuDate >= @weekStart
                          AND go.MenuDate <= @weekEnd
                    )
                    SELECT
                        ReasonCode,
                        SUM(Quantity) AS CancelledQuantity
                    FROM WeekCancellations
                    GROUP BY ReasonCode
                    ORDER BY CancelledQuantity DESC, ReasonCode;

                    SELECT
                        oc.OrderCancellationID,
                        o.MenuDate,
                        N'employee' AS OrderType,
                        o.EmployeeNo,
                        e.FirstName,
                        e.LastName,
                        oc.Quantity,
                        oc.ReasonCode,
                        oc.ReasonText,
                        oc.CancelledBy,
                        oc.CancelledAt
                    FROM dbo.OrderCancellations oc
                    INNER JOIN dbo.Orders o
                        ON oc.OrderType = N'Employee'
                       AND oc.OrderID = o.OrderID
                    LEFT JOIN dbo.Employees e
                        ON e.EmployeeNo = o.EmployeeNo
                    WHERE o.MenuDate >= @weekStart
                      AND o.MenuDate <= @weekEnd

                    UNION ALL

                    SELECT
                        oc.OrderCancellationID,
                        go.MenuDate,
                        N'guest' AS OrderType,
                        go.HostEmployeeNo AS EmployeeNo,
                        e.FirstName,
                        e.LastName,
                        oc.Quantity,
                        oc.ReasonCode,
                        oc.ReasonText,
                        oc.CancelledBy,
                        oc.CancelledAt
                    FROM dbo.OrderCancellations oc
                    INNER JOIN dbo.GuestOrders go
                        ON oc.OrderType = N'Guest'
                       AND oc.GuestOrderID = go.GuestOrderID
                    LEFT JOIN dbo.Employees e
                        ON e.EmployeeNo = go.HostEmployeeNo
                    WHERE go.MenuDate >= @weekStart
                      AND go.MenuDate <= @weekEnd
                    ORDER BY MenuDate, CancelledAt;
                `);

            const dailyRows = result.recordsets[0] || [];
            const reasonRows = result.recordsets[1] || [];
            const cancellationRows = result.recordsets[2] || [];

            const dailyByDate = new Map(
                dailyRows.map(row => [formatSqlDate(row.MenuDate), row])
            );

            const daily = createWeekDates(weekStart).map((date, index) => {
                const row = dailyByDate.get(date);
                const ordered = row ? Number(row.OrderedQuantity) : 0;
                const cancelled = row ? Number(row.CancelledQuantity) : 0;

                return {
                    date,
                    isoDay: index + 1,
                    dayName: ISO_DAY_NAMES[index],
                    ordered,
                    cancelled,
                    served: ordered - cancelled
                };
            });

            const ordered = sum(daily, item => item.ordered);
            const cancelled = sum(daily, item => item.cancelled);
            const served = sum(daily, item => item.served);
            const activeDays = daily.filter(item => item.ordered > 0);
            const peakDay = activeDays.length > 0
                ? activeDays.reduce((highest, item) =>
                    item.served > highest.served ? item : highest
                )
                : null;

            return {
                status: 200,
                jsonBody: {
                    week,
                    weekStart,
                    weekEnd,
                    generatedAt: new Date().toISOString(),
                    totals: {
                        ordered,
                        cancelled,
                        served,
                        cancellationPercent: ordered > 0
                            ? Number(((cancelled / ordered) * 100).toFixed(1))
                            : 0,
                        averageServedPerActiveDay: activeDays.length > 0
                            ? Number((served / activeDays.length).toFixed(1))
                            : 0,
                        activeDays: activeDays.length,
                        peakDay: peakDay
                            ? {
                                date: peakDay.date,
                                dayName: peakDay.dayName,
                                served: peakDay.served
                            }
                            : null
                    },
                    daily,
                    cancellationReasons: reasonRows.map(row => ({
                        reasonCode: row.ReasonCode,
                        quantity: Number(row.CancelledQuantity)
                    })),
                    cancellations: cancellationRows.map(row => ({
                        orderCancellationId: row.OrderCancellationID,
                        menuDate: formatSqlDate(row.MenuDate),
                        orderType: row.OrderType,
                        employeeNo: row.EmployeeNo,
                        employeeName: [row.FirstName, row.LastName]
                            .filter(Boolean)
                            .join(' ') || `Employee ${row.EmployeeNo}`,
                        quantity: Number(row.Quantity),
                        reasonCode: row.ReasonCode,
                        reasonText: row.ReasonText || null,
                        cancelledBy: row.CancelledBy,
                        cancelledAt: row.CancelledAt
                    }))
                }
            };
        } catch (error) {
            context.error('Kitchen weekly summary request failed', error);
            return {
                status: 500,
                jsonBody: {
                    error: 'Kitchen weekly summary request failed',
                    details: error.message
                }
            };
        }
    }
});

const ISO_DAY_NAMES = [
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
    'Sunday'
];

function getIsoWeekRange(value) {
    const match = /^(\d{4})-W(\d{2})$/.exec(value || '');
    if (!match) return null;

    const year = Number(match[1]);
    const week = Number(match[2]);
    if (week < 1 || week > 53) return null;

    const januaryFourth = new Date(Date.UTC(year, 0, 4));
    const januaryFourthIsoDay = januaryFourth.getUTCDay() || 7;
    const firstMonday = new Date(januaryFourth);
    firstMonday.setUTCDate(januaryFourth.getUTCDate() - januaryFourthIsoDay + 1);

    const start = new Date(firstMonday);
    start.setUTCDate(firstMonday.getUTCDate() + (week - 1) * 7);

    if (getIsoWeekYear(start) !== year || getIsoWeekNumber(start) !== week) {
        return null;
    }

    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);

    return {
        weekStart: formatUtcDate(start),
        weekEnd: formatUtcDate(end)
    };
}

function getIsoWeekYear(date) {
    const thursday = new Date(date);
    const isoDay = thursday.getUTCDay() || 7;
    thursday.setUTCDate(thursday.getUTCDate() + 4 - isoDay);
    return thursday.getUTCFullYear();
}

function getIsoWeekNumber(date) {
    const thursday = new Date(date);
    const isoDay = thursday.getUTCDay() || 7;
    thursday.setUTCDate(thursday.getUTCDate() + 4 - isoDay);

    const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
    return Math.ceil((((thursday - yearStart) / 86400000) + 1) / 7);
}

function createWeekDates(weekStart) {
    const start = new Date(`${weekStart}T00:00:00Z`);
    return Array.from({ length: 7 }, (_, index) => {
        const date = new Date(start);
        date.setUTCDate(start.getUTCDate() + index);
        return formatUtcDate(date);
    });
}

function formatSqlDate(value) {
    if (typeof value === 'string') return value.slice(0, 10);
    return value.toISOString().slice(0, 10);
}

function formatUtcDate(value) {
    return value.toISOString().slice(0, 10);
}

function sum(items, selector) {
    return items.reduce((total, item) => total + selector(item), 0);
}

function badRequest(message) {
    return {
        status: 400,
        jsonBody: { error: message }
    };
}
