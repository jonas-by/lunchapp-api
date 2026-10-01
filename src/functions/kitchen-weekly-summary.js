const { app } = require('@azure/functions');
const sql = require('mssql');

app.http('kitchen-weekly-summary', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'kitchen/weekly-summary',
    handler: async (request, context) => {
        const week = request.query.get('week');
        const range = getIsoWeekRange(week);

        if (!range) {
            return {
                status: 400,
                jsonBody: {
                    error: 'week is required and must use YYYY-Www format, for example 2026-W40'
                }
            };
        }

        try {
            const pool = await sql.connect(process.env.SqlConnectionString);
            const result = await pool.request()
                .input('weekStart', sql.Date, range.weekStart)
                .input('weekEnd', sql.Date, range.weekEnd)
                .query(`
                    WITH MealRows AS
                    (
                        SELECT
                            o.MenuDate,
                            o.Quantity AS OrderedQuantity,
                            o.Quantity - COALESCE(c.CancelledQuantity, 0) AS ServedQuantity,
                            COALESCE(c.CancelledQuantity, 0) AS CancelledQuantity
                        FROM dbo.Orders o
                        OUTER APPLY
                        (
                            SELECT SUM(oc.Quantity) AS CancelledQuantity
                            FROM dbo.OrderCancellations oc
                            WHERE oc.OrderType = N'Employee'
                              AND oc.OrderID = o.OrderID
                        ) c
                        WHERE o.MenuDate BETWEEN @weekStart AND @weekEnd

                        UNION ALL

                        SELECT
                            go.MenuDate,
                            go.Quantity,
                            go.Quantity - COALESCE(c.CancelledQuantity, 0),
                            COALESCE(c.CancelledQuantity, 0)
                        FROM dbo.GuestOrders go
                        OUTER APPLY
                        (
                            SELECT SUM(oc.Quantity) AS CancelledQuantity
                            FROM dbo.OrderCancellations oc
                            WHERE oc.OrderType = N'Guest'
                              AND oc.GuestOrderID = go.GuestOrderID
                        ) c
                        WHERE go.MenuDate BETWEEN @weekStart AND @weekEnd
                    ),
                    MealsByDate AS
                    (
                        SELECT
                            MenuDate,
                            SUM(OrderedQuantity) AS OrderedQuantity,
                            SUM(ServedQuantity) AS ServedQuantity,
                            SUM(CancelledQuantity) AS CancelledQuantity
                        FROM MealRows
                        GROUP BY MenuDate
                    ),
                    SaladRows AS
                    (
                        SELECT MenuDate, Quantity
                        FROM dbo.SaladOrders
                        WHERE MenuDate BETWEEN @weekStart AND @weekEnd

                        UNION ALL

                        SELECT MenuDate, Quantity
                        FROM dbo.GuestSaladOrders
                        WHERE MenuDate BETWEEN @weekStart AND @weekEnd
                    ),
                    SaladsByDate AS
                    (
                        SELECT MenuDate, SUM(Quantity) AS SaladQuantity
                        FROM SaladRows
                        GROUP BY MenuDate
                    ),
                    SummaryDates AS
                    (
                        SELECT MenuDate FROM MealsByDate
                        UNION
                        SELECT MenuDate FROM SaladsByDate
                    )
                    SELECT
                        d.MenuDate,
                        COALESCE(m.OrderedQuantity, 0) AS OrderedQuantity,
                        COALESCE(m.ServedQuantity, 0) AS ServedQuantity,
                        COALESCE(m.CancelledQuantity, 0) AS CancelledQuantity,
                        COALESCE(s.SaladQuantity, 0) AS SaladQuantity
                    FROM SummaryDates d
                    LEFT JOIN MealsByDate m ON m.MenuDate = d.MenuDate
                    LEFT JOIN SaladsByDate s ON s.MenuDate = d.MenuDate
                    ORDER BY d.MenuDate;

                    WITH SaladRows AS
                    (
                        SELECT SaladID, Quantity
                        FROM dbo.SaladOrders
                        WHERE MenuDate BETWEEN @weekStart AND @weekEnd

                        UNION ALL

                        SELECT SaladID, Quantity
                        FROM dbo.GuestSaladOrders
                        WHERE MenuDate BETWEEN @weekStart AND @weekEnd
                    )
                    SELECT
                        s.SaladID,
                        s.NameEn,
                        s.NameSv,
                        s.NameFi,
                        SUM(sr.Quantity) AS Quantity
                    FROM SaladRows sr
                    INNER JOIN dbo.Salads s ON s.SaladID = sr.SaladID
                    GROUP BY s.SaladID, s.NameEn, s.NameSv, s.NameFi, s.SortOrder
                    ORDER BY SUM(sr.Quantity) DESC, s.SortOrder, s.SaladID;

                    SELECT
                        oc.ReasonCode,
                        SUM(oc.Quantity) AS Quantity
                    FROM dbo.OrderCancellations oc
                    LEFT JOIN dbo.Orders o
                        ON oc.OrderType = N'Employee'
                       AND oc.OrderID = o.OrderID
                    LEFT JOIN dbo.GuestOrders go
                        ON oc.OrderType = N'Guest'
                       AND oc.GuestOrderID = go.GuestOrderID
                    WHERE COALESCE(o.MenuDate, go.MenuDate)
                          BETWEEN @weekStart AND @weekEnd
                    GROUP BY oc.ReasonCode
                    ORDER BY SUM(oc.Quantity) DESC, oc.ReasonCode;
                `);

            const rowsByDate = new Map(
                (result.recordsets[0] || []).map(row => [
                    formatSqlDate(row.MenuDate),
                    row
                ])
            );

            const daily = createWeekDates(range.weekStart).map((date, index) => {
                const row = rowsByDate.get(date) || {};
                const ordered = Number(row.OrderedQuantity || 0);
                const meals = Number(row.ServedQuantity || 0);
                const cancelled = Number(row.CancelledQuantity || 0);
                const salads = Number(row.SaladQuantity || 0);

                return {
                    date,
                    isoDay: index + 1,
                    dayName: ISO_DAY_NAMES[index],
                    ordered,
                    served: meals,
                    cancelled,
                    meals,
                    salads,
                    total: meals + salads
                };
            });

            const totals = {
                ordered: sum(daily, 'ordered'),
                served: sum(daily, 'served'),
                cancelled: sum(daily, 'cancelled'),
                meals: sum(daily, 'meals'),
                salads: sum(daily, 'salads'),
                total: sum(daily, 'total')
            };

            totals.cancellationPercent = totals.ordered > 0
                ? Number(((totals.cancelled / totals.ordered) * 100).toFixed(1))
                : 0;

            const peakDay = daily.reduce(
                (peak, day) => day.total > peak.total ? day : peak,
                daily[0]
            );

            totals.peakDay = peakDay && peakDay.total > 0
                ? {
                    date: peakDay.date,
                    dayName: peakDay.dayName,
                    total: peakDay.total,
                    served: peakDay.total
                }
                : null;

            return {
                status: 200,
                jsonBody: {
                    week,
                    weekStart: range.weekStart,
                    weekEnd: range.weekEnd,
                    generatedAt: new Date().toISOString(),
                    totals,
                    daily,
                    saladPopularity: (result.recordsets[1] || []).map(row => ({
                        saladId: row.SaladID,
                        nameEn: row.NameEn,
                        nameSv: row.NameSv,
                        nameFi: row.NameFi,
                        quantity: Number(row.Quantity)
                    })),
                    cancellationReasons: (result.recordsets[2] || []).map(row => ({
                        reasonCode: row.ReasonCode,
                        quantity: Number(row.Quantity)
                    })),
                    cancellations: []
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
    'Monday', 'Tuesday', 'Wednesday', 'Thursday',
    'Friday', 'Saturday', 'Sunday'
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
    firstMonday.setUTCDate(
        januaryFourth.getUTCDate() - januaryFourthIsoDay + 1
    );

    const start = new Date(firstMonday);
    start.setUTCDate(firstMonday.getUTCDate() + (week - 1) * 7);

    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);

    return {
        weekStart: formatUtcDate(start),
        weekEnd: formatUtcDate(end)
    };
}

function createWeekDates(weekStart) {
    const start = new Date(`${weekStart}T00:00:00Z`);
    return Array.from({ length: 7 }, (_, index) => {
        const date = new Date(start);
        date.setUTCDate(start.getUTCDate() + index);
        return formatUtcDate(date);
    });
}

function sum(items, property) {
    return items.reduce(
        (total, item) => total + Number(item[property] || 0),
        0
    );
}

function formatSqlDate(value) {
    if (typeof value === 'string') return value.slice(0, 10);
    return value.toISOString().slice(0, 10);
}

function formatUtcDate(value) {
    return value.toISOString().slice(0, 10);
}
