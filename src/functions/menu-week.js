const { app } = require('@azure/functions');
const sql = require('mssql');

app.http('menu-week', {
    methods: ['GET', 'PUT'],
    authLevel: 'anonymous',
    route: 'menu/week/{weekNumber}',

    handler: async (request, context) => {
        const weekNumber = Number.parseInt(request.params.weekNumber, 10);

        if (!Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > 8) {
            return {
                status: 400,
                jsonBody: {
                    error: 'Week number must be an integer between 1 and 8'
                }
            };
        }

        try {
            const pool = await sql.connect(process.env.SqlConnectionString);

            if (request.method === 'GET') {
                return await getMenuWeek(pool, weekNumber, context);
            }

            if (request.method === 'PUT') {
                return await putMenuWeek(pool, weekNumber, request, context);
            }

            return {
                status: 405,
                headers: {
                    Allow: 'GET, PUT'
                },
                jsonBody: {
                    error: 'Method not allowed'
                }
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

async function getMenuWeek(pool, weekNumber, context) {
    context.log(`Loading rotation week ${weekNumber}`);

    const result = await pool.request()
        .input('weekNumber', sql.Int, weekNumber)
        .query(`
            SELECT
                mw.WeekNumber,
                md.DayNumber,
                m.MealID,
                m.NameEN,
                m.NameSV,
                m.NameFI,
                m.Category
            FROM dbo.MenuWeeks mw
            INNER JOIN dbo.MenuDays md
                ON md.MenuWeekID = mw.MenuWeekID
            LEFT JOIN dbo.DayMeals dm
                ON dm.MenuDayID = md.MenuDayID
            LEFT JOIN dbo.Meals m
                ON m.MealID = dm.MealID
            WHERE mw.WeekNumber = @weekNumber
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
        return {
            status: 404,
            jsonBody: {
                error: `Menu week ${weekNumber} does not exist`
            }
        };
    }

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
                category: row.Category
            });
        }
    }

    return {
        status: 200,
        jsonBody: {
            weekNumber,
            days
        }
    };
}

async function putMenuWeek(pool, weekNumber, request, context) {
    context.log(`Saving rotation week ${weekNumber}`);

    let body;

    try {
        body = await request.json();
    } catch {
        return {
            status: 400,
            jsonBody: {
                error: 'Request body must contain valid JSON'
            }
        };
    }

    const validationError = validatePayload(body);

    if (validationError) {
        return {
            status: 400,
            jsonBody: {
                error: validationError
            }
        };
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
            SELECT MealID
            FROM dbo.Meals
            WHERE MealID IN (${parameterNames.join(', ')});
        `);

        const existingMealIds = new Set(
            mealCheckResult.recordset.map(row => row.MealID)
        );

        const missingMealIds = submittedMealIds.filter(
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

    const transaction = new sql.Transaction(pool);
    let transactionStarted = false;

    try {
        await transaction.begin();
        transactionStarted = true;

        const menuDaysResult = await new sql.Request(transaction)
            .input('weekNumber', sql.Int, weekNumber)
            .query(`
                SELECT
                    md.MenuDayID,
                    md.DayNumber
                FROM dbo.MenuWeeks mw
                INNER JOIN dbo.MenuDays md
                    ON md.MenuWeekID = mw.MenuWeekID
                WHERE mw.WeekNumber = @weekNumber
                ORDER BY md.DayNumber;
            `);

        if (menuDaysResult.recordset.length === 0) {
            await transaction.rollback();
            transactionStarted = false;

            return {
                status: 404,
                jsonBody: {
                    error: `Menu week ${weekNumber} does not exist`
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
                    error: `Menu week ${weekNumber} is missing weekdays in the database`,
                    missingDays
                }
            };
        }

        await new sql.Request(transaction)
            .input('weekNumber', sql.Int, weekNumber)
            .query(`
                DELETE dm
                FROM dbo.DayMeals dm
                INNER JOIN dbo.MenuDays md
                    ON md.MenuDayID = dm.MenuDayID
                INNER JOIN dbo.MenuWeeks mw
                    ON mw.MenuWeekID = md.MenuWeekID
                WHERE mw.WeekNumber = @weekNumber;
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
