const { app } = require('@azure/functions');
const sql = require('mssql');

app.http('menu-week', {
    methods: ['GET', 'PUT'],
    authLevel: 'anonymous',
    route: 'menu/cycles/{cycleId}/weeks/{weekNumber}',
    handler: async (request, context) => {
        const cycleId = Number.parseInt(request.params.cycleId, 10);
        const weekNumber = Number.parseInt(request.params.weekNumber, 10);

        if (!Number.isInteger(cycleId) || cycleId <= 0) {
            return badRequest('Cycle ID must be a positive integer');
        }

        if (!Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > 8) {
            return badRequest('Week number must be an integer between 1 and 8');
        }

        try {
            const pool = await sql.connect(process.env.SqlConnectionString);

            if (request.method === 'GET') {
                return await getMenuWeek(pool, cycleId, weekNumber, context);
            }

            if (request.method === 'PUT') {
                return await putMenuWeek(pool, cycleId, weekNumber, request, context);
            }

            return {
                status: 405,
                headers: { Allow: 'GET, PUT' },
                jsonBody: { error: 'Method not allowed' }
            };
        } catch (error) {
            context.error('Menu week request failed', error);
            return {
                status: 500,
                jsonBody: {
                    error: 'Menu week request failed',
                    details: error.message
                }
            };
        }
    }
});

async function getMenuWeek(pool, cycleId, weekNumber, context) {
    context.log(`Loading cycle ${cycleId}, rotation week ${weekNumber}`);

    const result = await pool.request()
        .input('cycleId', sql.Int, cycleId)
        .input('weekNumber', sql.Int, weekNumber)
        .query(`
            SELECT
                mc.MenuCycleID,
                mc.Name AS CycleName,
                mc.StartDate,
                mc.NumberOfWeeks,
                mc.Status,
                mw.MenuWeekID,
                mw.WeekNumber,
                md.DayNumber,
                m.MealID,
                m.NameEN,
                m.NameSV,
                m.NameFI,
                m.Category,
                m.Active
            FROM dbo.MenuCycles mc
            INNER JOIN dbo.MenuWeeks mw
                ON mw.MenuCycleID = mc.MenuCycleID
            INNER JOIN dbo.MenuDays md
                ON md.MenuWeekID = mw.MenuWeekID
            LEFT JOIN dbo.DayMeals dm
                ON dm.MenuDayID = md.MenuDayID
            LEFT JOIN dbo.Meals m
                ON m.MealID = dm.MealID
            WHERE mc.MenuCycleID = @cycleId
              AND mw.WeekNumber = @weekNumber
            ORDER BY
                md.DayNumber,
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

    if (result.recordset.length === 0) {
        return notFound(`Menu cycle ${cycleId}, week ${weekNumber} does not exist`);
    }

    const firstRow = result.recordset[0];
    const days = [1, 2, 3, 4, 5].map(dayNumber => ({
        dayNumber,
        meals: []
    }));

    for (const row of result.recordset) {
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
            menuCycleId: firstRow.MenuCycleID,
            cycleName: firstRow.CycleName,
            startDate: formatDate(firstRow.StartDate),
            numberOfWeeks: firstRow.NumberOfWeeks,
            status: firstRow.Status,
            menuWeekId: firstRow.MenuWeekID,
            weekNumber,
            days
        }
    };
}

async function putMenuWeek(pool, cycleId, weekNumber, request, context) {
    context.log(`Saving cycle ${cycleId}, rotation week ${weekNumber}`);

    let body;
    try {
        body = await request.json();
    } catch {
        return badRequest('Request body must contain valid JSON');
    }

    const validationError = validatePayload(body);
    if (validationError) {
        return badRequest(validationError);
    }

    const days = body.days.map(day => ({
        dayNumber: day.dayNumber,
        mealIds: [...new Set(day.mealIds)]
    }));

    const submittedMealIds = [
        ...new Set(days.flatMap(day => day.mealIds))
    ];

    if (submittedMealIds.length > 0) {
        const mealCheckRequest = pool.request();
        const parameterNames = submittedMealIds.map((mealId, index) => {
            const parameterName = `mealId${index}`;
            mealCheckRequest.input(parameterName, sql.Int, mealId);
            return `@${parameterName}`;
        });

        const mealCheckResult = await mealCheckRequest.query(`
            SELECT MealID, Active
            FROM dbo.Meals
            WHERE MealID IN (${parameterNames.join(', ')});
        `);

        const existingMeals = new Map(
            mealCheckResult.recordset.map(row => [row.MealID, Boolean(row.Active)])
        );

        const missingMealIds = submittedMealIds.filter(
            mealId => !existingMeals.has(mealId)
        );

        if (missingMealIds.length > 0) {
            return badRequestWithDetails(
                'One or more submitted meals do not exist',
                { missingMealIds }
            );
        }

        const inactiveMealIds = submittedMealIds.filter(
            mealId => existingMeals.get(mealId) === false
        );

        if (inactiveMealIds.length > 0) {
            return {
                status: 409,
                jsonBody: {
                    error: 'Archived meals cannot be added to a menu',
                    inactiveMealIds
                }
            };
        }
    }

    const transaction = new sql.Transaction(pool);
    let transactionStarted = false;

    try {
        await transaction.begin();
        transactionStarted = true;

        const menuDaysResult = await new sql.Request(transaction)
            .input('cycleId', sql.Int, cycleId)
            .input('weekNumber', sql.Int, weekNumber)
            .query(`
                SELECT
                    md.MenuDayID,
                    md.DayNumber,
                    mc.Status
                FROM dbo.MenuCycles mc
                INNER JOIN dbo.MenuWeeks mw
                    ON mw.MenuCycleID = mc.MenuCycleID
                INNER JOIN dbo.MenuDays md
                    ON md.MenuWeekID = mw.MenuWeekID
                WHERE mc.MenuCycleID = @cycleId
                  AND mw.WeekNumber = @weekNumber
                ORDER BY md.DayNumber;
            `);

        if (menuDaysResult.recordset.length === 0) {
            await transaction.rollback();
            transactionStarted = false;
            return notFound(`Menu cycle ${cycleId}, week ${weekNumber} does not exist`);
        }

        if (menuDaysResult.recordset[0].Status === 'Archived') {
            await transaction.rollback();
            transactionStarted = false;
            return {
                status: 409,
                jsonBody: {
                    error: 'Archived menu cycles cannot be edited'
                }
            };
        }

        const menuDayIds = new Map(
            menuDaysResult.recordset.map(row => [
                row.DayNumber,
                row.MenuDayID
            ])
        );

        const missingDays = [1, 2, 3, 4, 5].filter(
            dayNumber => !menuDayIds.has(dayNumber)
        );

        if (missingDays.length > 0) {
            await transaction.rollback();
            transactionStarted = false;
            return {
                status: 409,
                jsonBody: {
                    error: `Menu cycle ${cycleId}, week ${weekNumber} is missing weekdays in the database`,
                    missingDays
                }
            };
        }

        await new sql.Request(transaction)
            .input('cycleId', sql.Int, cycleId)
            .input('weekNumber', sql.Int, weekNumber)
            .query(`
                DELETE dm
                FROM dbo.DayMeals dm
                INNER JOIN dbo.MenuDays md
                    ON md.MenuDayID = dm.MenuDayID
                INNER JOIN dbo.MenuWeeks mw
                    ON mw.MenuWeekID = md.MenuWeekID
                WHERE mw.MenuCycleID = @cycleId
                  AND mw.WeekNumber = @weekNumber;
            `);

        let insertedMeals = 0;

        for (const day of days) {
            const menuDayId = menuDayIds.get(day.dayNumber);

            for (const mealId of day.mealIds) {
                await new sql.Request(transaction)
                    .input('menuDayId', sql.Int, menuDayId)
                    .input('mealId', sql.Int, mealId)
                    .query(`
                        INSERT INTO dbo.DayMeals
                        (
                            MenuDayID,
                            MealID
                        )
                        VALUES
                        (
                            @menuDayId,
                            @mealId
                        );
                    `);

                insertedMeals += 1;
            }
        }

        await transaction.commit();
        transactionStarted = false;

        return {
            status: 200,
            jsonBody: {
                success: true,
                menuCycleId: cycleId,
                weekNumber,
                insertedMeals
            }
        };
    } catch (error) {
        if (transactionStarted) {
            try {
                await transaction.rollback();
            } catch (rollbackError) {
                context.error('Transaction rollback failed', rollbackError);
            }
        }

        throw error;
    }
}

function validatePayload(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return 'Request body must be a JSON object';
    }

    if (!Array.isArray(body.days)) {
        return 'The days property must be an array';
    }

    if (body.days.length !== 5) {
        return 'The request must contain exactly five days';
    }

    const submittedDays = new Set();

    for (const day of body.days) {
        if (!day || typeof day !== 'object' || Array.isArray(day)) {
            return 'Every day must be an object';
        }

        if (!Number.isInteger(day.dayNumber) || day.dayNumber < 1 || day.dayNumber > 5) {
            return 'Every dayNumber must be an integer between 1 and 5';
        }

        if (submittedDays.has(day.dayNumber)) {
            return `Day ${day.dayNumber} appears more than once`;
        }

        submittedDays.add(day.dayNumber);

        if (!Array.isArray(day.mealIds)) {
            return `mealIds for day ${day.dayNumber} must be an array`;
        }

        const invalidMealId = day.mealIds.find(
            mealId => !Number.isInteger(mealId) || mealId <= 0
        );

        if (invalidMealId !== undefined) {
            return `All mealIds for day ${day.dayNumber} must be positive integers`;
        }
    }

    const missingDays = [1, 2, 3, 4, 5].filter(
        dayNumber => !submittedDays.has(dayNumber)
    );

    if (missingDays.length > 0) {
        return `Missing day numbers: ${missingDays.join(', ')}`;
    }

    return null;
}

function formatDate(value) {
    if (typeof value === 'string') return value.slice(0, 10);
    return value.toISOString().slice(0, 10);
}

function badRequest(message) {
    return {
        status: 400,
        jsonBody: { error: message }
    };
}

function badRequestWithDetails(message, details) {
    return {
        status: 400,
        jsonBody: {
            error: message,
            ...details
        }
    };
}

function notFound(message) {
    return {
        status: 404,
        jsonBody: { error: message }
    };
}
