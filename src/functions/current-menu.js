const { app } = require('@azure/functions');
const sql = require('mssql');

app.http('current-menu', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'menu/current',
    handler: async (request, context) => {
        const requestedDate = request.query.get('date') || todayInFinland();
        if (!isIsoDate(requestedDate)) {
            return { status: 400, jsonBody: { error: 'Date must use YYYY-MM-DD format' } };
        }

        try {
            const pool = await sql.connect(process.env.SqlConnectionString);
            const cycleResult = await pool.request()
                .input('requestedDate', sql.Date, requestedDate)
                .query(`
                    SELECT TOP (1)
                        MenuCycleID,
                        Name,
                        StartDate,
                        NumberOfWeeks,
                        Status
                    FROM dbo.MenuCycles
                    WHERE Status = N'Published'
                      AND StartDate <= @requestedDate
                    ORDER BY StartDate DESC, MenuCycleID DESC;
                `);

            if (cycleResult.recordset.length === 0) {
                return {
                    status: 404,
                    jsonBody: { error: `No published menu cycle covers ${requestedDate}` }
                };
            }

            const cycle = cycleResult.recordset[0];
            const startDate = formatDate(cycle.StartDate);
            const elapsedDays = daysBetween(startDate, requestedDate);
            const elapsedWeeks = Math.floor(elapsedDays / 7);
            const weekNumber = (elapsedWeeks % cycle.NumberOfWeeks) + 1;

            const menuResult = await pool.request()
                .input('cycleId', sql.Int, cycle.MenuCycleID)
                .input('weekNumber', sql.Int, weekNumber)
                .query(`
                    SELECT
                        mw.MenuWeekID,
                        md.DayNumber,
                        m.MealID,
                        m.NameEN,
                        m.NameSV,
                        m.NameFI,
                        m.Category,
                        m.Active
                    FROM dbo.MenuWeeks mw
                    INNER JOIN dbo.MenuDays md
                        ON md.MenuWeekID = mw.MenuWeekID
                    LEFT JOIN dbo.DayMeals dm
                        ON dm.MenuDayID = md.MenuDayID
                    LEFT JOIN dbo.Meals m
                        ON m.MealID = dm.MealID
                    WHERE mw.MenuCycleID = @cycleId
                      AND mw.WeekNumber = @weekNumber
                    ORDER BY md.DayNumber, dm.DayMealID;
                `);

            if (menuResult.recordset.length === 0) {
                return {
                    status: 404,
                    jsonBody: { error: `Menu week ${weekNumber} does not exist in cycle ${cycle.MenuCycleID}` }
                };
            }

            const days = [1, 2, 3, 4, 5].map(dayNumber => ({ dayNumber, meals: [] }));
            for (const row of menuResult.recordset) {
                if (row.MealID !== null) {
                    days[row.DayNumber - 1].meals.push({
                        mealId: row.MealID,
                        nameEN: row.NameEN,
                        nameSV: row.NameSV,
                        nameFI: row.NameFI,
                        category: row.Category,
                        active: Boolean(row.Active)
                    });
                }
            }

            return {
                status: 200,
                jsonBody: {
                    requestedDate,
                    menuCycleId: cycle.MenuCycleID,
                    cycleName: cycle.Name,
                    cycleStartDate: startDate,
                    numberOfWeeks: cycle.NumberOfWeeks,
                    weekNumber,
                    menuWeekId: menuResult.recordset[0].MenuWeekID,
                    days
                }
            };
        } catch (error) {
            context.error('Current menu request failed', error);
            return {
                status: 500,
                jsonBody: { error: 'Current menu request failed', details: error.message }
            };
        }
    }
});

function todayInFinland() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Helsinki',
        year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
}

function daysBetween(fromDate, toDate) {
    const from = Date.parse(`${fromDate}T00:00:00Z`);
    const to = Date.parse(`${toDate}T00:00:00Z`);
    return Math.floor((to - from) / 86400000);
}

function formatDate(value) {
    if (typeof value === 'string') return value.slice(0, 10);
    return value.toISOString().slice(0, 10);
}

function isIsoDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
