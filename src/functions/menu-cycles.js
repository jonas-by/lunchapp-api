const { app } = require('@azure/functions');
const sql = require('mssql');

app.http('menu-cycles', {
    methods: ['GET', 'POST', 'PUT'],
    authLevel: 'anonymous',
    route: 'menu/cycles/{cycleId?}',
    handler: async (request, context) => {
        const cycleIdText = request.params.cycleId;
        const cycleId = cycleIdText === undefined
            ? null
            : Number.parseInt(cycleIdText, 10);

        if (cycleIdText !== undefined && (!Number.isInteger(cycleId) || cycleId <= 0)) {
            return badRequest('Cycle ID must be a positive integer');
        }

        try {
            const pool = await sql.connect(process.env.SqlConnectionString);

            if (request.method === 'GET') {
                return cycleId === null
                    ? await listCycles(pool)
                    : await getCycle(pool, cycleId);
            }

            if (request.method === 'POST') {
                if (cycleId !== null) {
                    return badRequest('Do not include a cycle ID when creating a menu cycle');
                }
                return await createCycle(pool, request, context);
            }

            if (request.method === 'PUT') {
                if (cycleId === null) {
                    return badRequest('Cycle ID is required when updating a menu cycle');
                }
                return await updateCycle(pool, cycleId, request, context);
            }

            return {
                status: 405,
                headers: { Allow: 'GET, POST, PUT' },
                jsonBody: { error: 'Method not allowed' }
            };
        } catch (error) {
            context.error('Menu cycle request failed', error);
            return {
                status: 500,
                jsonBody: {
                    error: 'Menu cycle request failed',
                    details: error.message
                }
            };
        }
    }
});

async function listCycles(pool) {
    const result = await pool.request().query(`
        SELECT
            mc.MenuCycleID,
            mc.Name,
            mc.StartDate,
            mc.NumberOfWeeks,
            mc.Status,
            mc.CreatedDate,
            mc.UpdatedDate,
            COUNT(mw.MenuWeekID) AS ConfiguredWeeks
        FROM dbo.MenuCycles mc
        LEFT JOIN dbo.MenuWeeks mw
            ON mw.MenuCycleID = mc.MenuCycleID
        GROUP BY
            mc.MenuCycleID,
            mc.Name,
            mc.StartDate,
            mc.NumberOfWeeks,
            mc.Status,
            mc.CreatedDate,
            mc.UpdatedDate
        ORDER BY
            mc.StartDate DESC,
            mc.MenuCycleID DESC;
    `);

    return {
        status: 200,
        jsonBody: result.recordset.map(mapCycle)
    };
}

async function getCycle(pool, cycleId) {
    const result = await pool.request()
        .input('cycleId', sql.Int, cycleId)
        .query(`
            SELECT
                mc.MenuCycleID,
                mc.Name,
                mc.StartDate,
                mc.NumberOfWeeks,
                mc.Status,
                mc.CreatedDate,
                mc.UpdatedDate,
                COUNT(mw.MenuWeekID) AS ConfiguredWeeks
            FROM dbo.MenuCycles mc
            LEFT JOIN dbo.MenuWeeks mw
                ON mw.MenuCycleID = mc.MenuCycleID
            WHERE mc.MenuCycleID = @cycleId
            GROUP BY
                mc.MenuCycleID,
                mc.Name,
                mc.StartDate,
                mc.NumberOfWeeks,
                mc.Status,
                mc.CreatedDate,
                mc.UpdatedDate;
        `);

    if (result.recordset.length === 0) {
        return notFound(`Menu cycle ${cycleId} does not exist`);
    }

    return {
        status: 200,
        jsonBody: mapCycle(result.recordset[0])
    };
}

async function createCycle(pool, request, context) {
    const bodyResult = await readJson(request);
    if (bodyResult.error) return bodyResult.error;

    const validation = validateCycle(bodyResult.body, { partial: false });
    if (validation.error) return badRequest(validation.error);

    const cycle = validation.cycle;
    const conflict = await findStartDateConflict(pool, cycle.startDate, null);
    if (conflict) {
        return conflictResponse(cycle.startDate, conflict);
    }

    const transaction = new sql.Transaction(pool);
    let transactionStarted = false;

    try {
        await transaction.begin();
        transactionStarted = true;

        const insertResult = await new sql.Request(transaction)
            .input('name', sql.NVarChar(100), cycle.name)
            .input('startDate', sql.Date, cycle.startDate)
            .input('numberOfWeeks', sql.TinyInt, cycle.numberOfWeeks)
            .input('status', sql.NVarChar(20), cycle.status)
            .query(`
                INSERT INTO dbo.MenuCycles
                (
                    Name,
                    StartDate,
                    NumberOfWeeks,
                    Status
                )
                OUTPUT INSERTED.MenuCycleID
                VALUES
                (
                    @name,
                    @startDate,
                    @numberOfWeeks,
                    @status
                );
            `);

        const cycleId = insertResult.recordset[0].MenuCycleID;

        for (let weekNumber = 1; weekNumber <= cycle.numberOfWeeks; weekNumber += 1) {
            const weekResult = await new sql.Request(transaction)
                .input('cycleId', sql.Int, cycleId)
                .input('weekNumber', sql.Int, weekNumber)
                .query(`
                    INSERT INTO dbo.MenuWeeks
                    (
                        MenuCycleID,
                        WeekNumber
                    )
                    OUTPUT INSERTED.MenuWeekID
                    VALUES
                    (
                        @cycleId,
                        @weekNumber
                    );
                `);

            const menuWeekId = weekResult.recordset[0].MenuWeekID;

            for (let dayNumber = 1; dayNumber <= 5; dayNumber += 1) {
                await new sql.Request(transaction)
                    .input('menuWeekId', sql.Int, menuWeekId)
                    .input('dayNumber', sql.TinyInt, dayNumber)
                    .query(`
                        INSERT INTO dbo.MenuDays
                        (
                            MenuWeekID,
                            DayNumber
                        )
                        VALUES
                        (
                            @menuWeekId,
                            @dayNumber
                        );
                    `);
            }
        }

        await transaction.commit();
        transactionStarted = false;
        context.log(`Created menu cycle ${cycleId} with ${cycle.numberOfWeeks} weeks`);

        return {
            status: 201,
            headers: { Location: `/api/menu/cycles/${cycleId}` },
            jsonBody: {
                menuCycleId: cycleId,
                ...cycle,
                configuredWeeks: cycle.numberOfWeeks
            }
        };
    } catch (error) {
        if (transactionStarted) {
            try {
                await transaction.rollback();
            } catch (rollbackError) {
                context.error('Menu cycle rollback failed', rollbackError);
            }
        }
        throw error;
    }
}

async function updateCycle(pool, cycleId, request, context) {
    const bodyResult = await readJson(request);
    if (bodyResult.error) return bodyResult.error;

    const existingResult = await pool.request()
        .input('cycleId', sql.Int, cycleId)
        .query(`
            SELECT
                MenuCycleID,
                Name,
                StartDate,
                NumberOfWeeks,
                Status
            FROM dbo.MenuCycles
            WHERE MenuCycleID = @cycleId;
        `);

    if (existingResult.recordset.length === 0) {
        return notFound(`Menu cycle ${cycleId} does not exist`);
    }

    const existing = existingResult.recordset[0];
    const merged = {
        name: bodyResult.body.name ?? existing.Name,
        startDate: bodyResult.body.startDate ?? formatDate(existing.StartDate),
        numberOfWeeks: bodyResult.body.numberOfWeeks ?? existing.NumberOfWeeks,
        status: bodyResult.body.status ?? existing.Status
    };

    const validation = validateCycle(merged, { partial: false });
    if (validation.error) return badRequest(validation.error);

    const cycle = validation.cycle;

    if (cycle.numberOfWeeks !== existing.NumberOfWeeks) {
        return {
            status: 409,
            jsonBody: {
                error: 'Changing the number of weeks is not supported after a cycle has been created',
                currentNumberOfWeeks: existing.NumberOfWeeks
            }
        };
    }

    const conflict = await findStartDateConflict(pool, cycle.startDate, cycleId);
    if (conflict) {
        return conflictResponse(cycle.startDate, conflict);
    }

    if (cycle.status === 'Published' && existing.Status !== 'Published') {
        const publishValidation = await validateCycleForPublishing(
            pool,
            cycleId,
            existing.NumberOfWeeks
        );

        if (!publishValidation.valid) {
            return {
                status: 409,
                jsonBody: {
                    error: 'Menu cycle cannot be published',
                    configuredWeeks: publishValidation.configuredWeeks,
                    expectedWeeks: existing.NumberOfWeeks,
                    incompleteDays: publishValidation.incompleteDays,
                    archivedMeals: publishValidation.archivedMeals
                }
            };
        }
    }

    const result = await pool.request()
        .input('cycleId', sql.Int, cycleId)
        .input('name', sql.NVarChar(100), cycle.name)
        .input('startDate', sql.Date, cycle.startDate)
        .input('status', sql.NVarChar(20), cycle.status)
        .query(`
            UPDATE dbo.MenuCycles
            SET
                Name = @name,
                StartDate = @startDate,
                Status = @status,
                UpdatedDate = SYSUTCDATETIME()
            OUTPUT
                INSERTED.MenuCycleID,
                INSERTED.Name,
                INSERTED.StartDate,
                INSERTED.NumberOfWeeks,
                INSERTED.Status,
                INSERTED.CreatedDate,
                INSERTED.UpdatedDate
            WHERE MenuCycleID = @cycleId;
        `);

    context.log(`Updated menu cycle ${cycleId}`);

    return {
        status: 200,
        jsonBody: mapCycle(result.recordset[0])
    };
}

async function validateCycleForPublishing(pool, cycleId, expectedWeeks) {
    const result = await pool.request()
        .input('cycleId', sql.Int, cycleId)
        .query(`
            SELECT
                mw.WeekNumber,
                md.DayNumber,
                m.MealID,
                m.NameEN,
                m.NameSV,
                m.NameFI,
                m.Active
            FROM dbo.MenuWeeks mw
            LEFT JOIN dbo.MenuDays md
                ON md.MenuWeekID = mw.MenuWeekID
            LEFT JOIN dbo.DayMeals dm
                ON dm.MenuDayID = md.MenuDayID
            LEFT JOIN dbo.Meals m
                ON m.MealID = dm.MealID
            WHERE mw.MenuCycleID = @cycleId
            ORDER BY
                mw.WeekNumber,
                md.DayNumber,
                m.MealID;
        `);

    const configuredWeeks = new Set(
        result.recordset.map(row => Number(row.WeekNumber))
    );
    const incompleteDays = [];
    const archivedMeals = [];

    for (let weekNumber = 1; weekNumber <= expectedWeeks; weekNumber += 1) {
        if (!configuredWeeks.has(weekNumber)) {
            for (let dayNumber = 1; dayNumber <= 5; dayNumber += 1) {
                incompleteDays.push({
                    weekNumber,
                    dayNumber,
                    reason: 'Menu week does not exist'
                });
            }
            continue;
        }

        for (let dayNumber = 1; dayNumber <= 5; dayNumber += 1) {
            const rows = result.recordset.filter(row =>
                Number(row.WeekNumber) === weekNumber &&
                Number(row.DayNumber) === dayNumber
            );

            if (rows.length === 0) {
                incompleteDays.push({
                    weekNumber,
                    dayNumber,
                    reason: 'Menu day does not exist'
                });
                continue;
            }

            const assignedMeals = rows.filter(row => row.MealID !== null);
            if (assignedMeals.length === 0) {
                incompleteDays.push({
                    weekNumber,
                    dayNumber,
                    reason: 'No meals assigned'
                });
                continue;
            }

            for (const row of assignedMeals) {
                if (!Boolean(row.Active)) {
                    archivedMeals.push({
                        weekNumber,
                        dayNumber,
                        mealId: row.MealID,
                        mealName: row.NameEN || row.NameSV || row.NameFI || `Meal ${row.MealID}`
                    });
                }
            }
        }
    }

    return {
        valid:
            configuredWeeks.size === expectedWeeks &&
            incompleteDays.length === 0 &&
            archivedMeals.length === 0,
        configuredWeeks: configuredWeeks.size,
        incompleteDays,
        archivedMeals
    };
}

async function findStartDateConflict(pool, startDate, excludedCycleId) {
    const request = pool.request()
        .input('startDate', sql.Date, startDate)
        .input('excludedCycleId', sql.Int, excludedCycleId);

    const result = await request.query(`
        SELECT TOP (1)
            MenuCycleID,
            Name,
            Status
        FROM dbo.MenuCycles
        WHERE StartDate = @startDate
          AND (@excludedCycleId IS NULL OR MenuCycleID <> @excludedCycleId)
        ORDER BY MenuCycleID;
    `);

    return result.recordset[0] ?? null;
}

function validateCycle(body, options) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { error: 'Request body must be a JSON object' };
    }

    const allowedFields = new Set(['name', 'startDate', 'numberOfWeeks', 'status']);
    const unknownFields = Object.keys(body).filter(key => !allowedFields.has(key));
    if (unknownFields.length > 0) {
        return { error: `Unknown properties: ${unknownFields.join(', ')}` };
    }

    if (!options.partial || body.name !== undefined) {
        if (typeof body.name !== 'string' || body.name.trim().length === 0) {
            return { error: 'Name is required' };
        }
        if (body.name.trim().length > 100) {
            return { error: 'Name must not exceed 100 characters' };
        }
    }

    if (!options.partial || body.startDate !== undefined) {
        if (!isIsoDate(body.startDate)) {
            return { error: 'Start date must use YYYY-MM-DD format and be a valid date' };
        }
        if (!isMonday(body.startDate)) {
            return { error: 'Start date must be a Monday' };
        }
    }

    if (!options.partial || body.numberOfWeeks !== undefined) {
        if (!Number.isInteger(body.numberOfWeeks) || body.numberOfWeeks < 1 || body.numberOfWeeks > 8) {
            return { error: 'Number of weeks must be an integer between 1 and 8' };
        }
    }

    if (!options.partial || body.status !== undefined) {
        if (!['Draft', 'Published', 'Archived'].includes(body.status)) {
            return { error: 'Status must be Draft, Published or Archived' };
        }
    }

    return {
        cycle: {
            name: body.name.trim(),
            startDate: body.startDate,
            numberOfWeeks: body.numberOfWeeks,
            status: body.status
        }
    };
}

async function readJson(request) {
    try {
        return { body: await request.json() };
    } catch {
        return { error: badRequest('Request body must contain valid JSON') };
    }
}

function mapCycle(row) {
    return {
        menuCycleId: row.MenuCycleID,
        name: row.Name,
        startDate: formatDate(row.StartDate),
        numberOfWeeks: row.NumberOfWeeks,
        status: row.Status,
        configuredWeeks: row.ConfiguredWeeks === undefined
            ? row.NumberOfWeeks
            : Number(row.ConfiguredWeeks),
        createdDate: row.CreatedDate,
        updatedDate: row.UpdatedDate
    };
}

function formatDate(value) {
    if (typeof value === 'string') return value.slice(0, 10);
    return value.toISOString().slice(0, 10);
}

function isIsoDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isMonday(value) {
    return new Date(`${value}T00:00:00Z`).getUTCDay() === 1;
}

function badRequest(message) {
    return { status: 400, jsonBody: { error: message } };
}

function notFound(message) {
    return { status: 404, jsonBody: { error: message } };
}

function conflictResponse(startDate, conflict) {
    return {
        status: 409,
        jsonBody: {
            error: `Another menu cycle already starts on ${startDate}`,
            conflictingCycle: {
                menuCycleId: conflict.MenuCycleID,
                name: conflict.Name,
                status: conflict.Status
            }
        }
    };
}
