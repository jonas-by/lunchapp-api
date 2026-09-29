const { app } = require('@azure/functions');
const sql = require('mssql');

const VALID_CATEGORIES = new Set([
    'Main',
    'Vegetarian',
    'Soup',
    'Salad',
    'Dessert'
]);

app.http('meals', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    route: 'meals',
    handler: handleMeals
});

app.http('meal-item', {
    methods: ['PUT', 'DELETE'],
    authLevel: 'anonymous',
    route: 'meals/{mealId}',
    handler: handleMealItem
});

async function handleMeals(request, context) {
    try {
        const pool = await sql.connect(process.env.SqlConnectionString);

        if (request.method === 'GET') {
            return await getMeals(pool, request, context);
        }

        if (request.method === 'POST') {
            return await createMeal(pool, request, context);
        }

        return methodNotAllowed('GET, POST');
    } catch (error) {
        return serverError(context, 'Meals request failed', error);
    }
}

async function handleMealItem(request, context) {
    const mealId = Number.parseInt(request.params.mealId, 10);

    if (!Number.isInteger(mealId) || mealId <= 0) {
        return {
            status: 400,
            jsonBody: {
                error: 'mealId must be a positive integer'
            }
        };
    }

    try {
        const pool = await sql.connect(process.env.SqlConnectionString);

        if (request.method === 'PUT') {
            return await updateMeal(pool, mealId, request, context);
        }

        if (request.method === 'DELETE') {
            return await deleteMeal(pool, mealId, request, context);
        }

        return methodNotAllowed('PUT, DELETE');
    } catch (error) {
        return serverError(context, 'Meal request failed', error);
    }
}

async function getMeals(pool, request, context) {
    const url = new URL(request.url);
    const includeInactive = parseBoolean(url.searchParams.get('includeInactive'), false);
    const categoryInput = url.searchParams.get('category');
    let category = null;

    if (categoryInput) {
        category = normaliseCategory(categoryInput);

        if (!category) {
            return {
                status: 400,
                jsonBody: {
                    error: `Category must be one of: ${[...VALID_CATEGORIES].join(', ')}`
                }
            };
        }
    }

    context.log(
        `Reading meals. includeInactive=${includeInactive}, category=${category || 'all'}`
    );

    const dbRequest = pool.request()
        .input('includeInactive', sql.Bit, includeInactive);

    let categoryFilter = '';

    if (category) {
        dbRequest.input('category', sql.NVarChar(20), category);
        categoryFilter = 'AND Category = @category';
    }

    const result = await dbRequest.query(`
        SELECT
            MealID,
            NameEN,
            NameSV,
            NameFI,
            Category,
            Active
        FROM dbo.Meals
        WHERE
            (@includeInactive = 1 OR Active = 1)
            ${categoryFilter}
        ORDER BY
            CASE Category
                WHEN 'Main' THEN 1
                WHEN 'Vegetarian' THEN 2
                WHEN 'Soup' THEN 3
                WHEN 'Salad' THEN 4
                WHEN 'Dessert' THEN 5
                ELSE 6
            END,
            NameSV;
    `);

    return {
        status: 200,
        jsonBody: result.recordset
    };
}

async function createMeal(pool, request, context) {
    const bodyResult = await readJsonBody(request);

    if (bodyResult.error) {
        return bodyResult.error;
    }

    const mealResult = validateMeal(bodyResult.body, false);

    if (mealResult.error) {
        return {
            status: 400,
            jsonBody: {
                error: mealResult.error
            }
        };
    }

    const meal = mealResult.meal;

    context.log(`Creating meal: ${meal.nameSV}`);

    const result = await pool.request()
        .input('nameEN', sql.NVarChar(200), meal.nameEN)
        .input('nameSV', sql.NVarChar(200), meal.nameSV)
        .input('nameFI', sql.NVarChar(200), meal.nameFI)
        .input('category', sql.NVarChar(20), meal.category)
        .input('active', sql.Bit, meal.active)
        .query(`
            INSERT INTO dbo.Meals
            (
                NameEN,
                NameSV,
                NameFI,
                Category,
                Active
            )
            OUTPUT
                INSERTED.MealID,
                INSERTED.NameEN,
                INSERTED.NameSV,
                INSERTED.NameFI,
                INSERTED.Category,
                INSERTED.Active
            VALUES
            (
                @nameEN,
                @nameSV,
                @nameFI,
                @category,
                @active
            );
        `);

    return {
        status: 201,
        headers: {
            Location: `/api/meals/${result.recordset[0].MealID}`
        },
        jsonBody: result.recordset[0]
    };
}

async function updateMeal(pool, mealId, request, context) {
    const bodyResult = await readJsonBody(request);

    if (bodyResult.error) {
        return bodyResult.error;
    }

    const mealResult = validateMeal(bodyResult.body, true);

    if (mealResult.error) {
        return {
            status: 400,
            jsonBody: {
                error: mealResult.error
            }
        };
    }

    const meal = mealResult.meal;

    context.log(`Updating meal ${mealId}`);

    const result = await pool.request()
        .input('mealId', sql.Int, mealId)
        .input('nameEN', sql.NVarChar(200), meal.nameEN)
        .input('nameSV', sql.NVarChar(200), meal.nameSV)
        .input('nameFI', sql.NVarChar(200), meal.nameFI)
        .input('category', sql.NVarChar(20), meal.category)
        .input('active', sql.Bit, meal.active)
        .query(`
            UPDATE dbo.Meals
            SET
                NameEN = @nameEN,
                NameSV = @nameSV,
                NameFI = @nameFI,
                Category = @category,
                Active = @active
            OUTPUT
                INSERTED.MealID,
                INSERTED.NameEN,
                INSERTED.NameSV,
                INSERTED.NameFI,
                INSERTED.Category,
                INSERTED.Active
            WHERE MealID = @mealId;
        `);

    if (result.recordset.length === 0) {
        return {
            status: 404,
            jsonBody: {
                error: `Meal ${mealId} does not exist`
            }
        };
    }

    return {
        status: 200,
        jsonBody: result.recordset[0]
    };
}

async function deleteMeal(pool, mealId, request, context) {
    const url = new URL(request.url);
    const hardDelete = parseBoolean(url.searchParams.get('hard'), false);

    if (!hardDelete) {
        context.log(`Soft-deleting meal ${mealId}`);

        const result = await pool.request()
            .input('mealId', sql.Int, mealId)
            .query(`
                UPDATE dbo.Meals
                SET Active = 0
                OUTPUT
                    INSERTED.MealID,
                    INSERTED.NameEN,
                    INSERTED.NameSV,
                    INSERTED.NameFI,
                    INSERTED.Category,
                    INSERTED.Active
                WHERE MealID = @mealId;
            `);

        if (result.recordset.length === 0) {
            return {
                status: 404,
                jsonBody: {
                    error: `Meal ${mealId} does not exist`
                }
            };
        }

        return {
            status: 200,
            jsonBody: {
                success: true,
                deleteType: 'soft',
                meal: result.recordset[0]
            }
        };
    }

    context.log(`Permanently deleting meal ${mealId}`);

    const transaction = new sql.Transaction(pool);
    let transactionStarted = false;

    try {
        await transaction.begin();
        transactionStarted = true;

        const referenceResult = await new sql.Request(transaction)
            .input('mealId', sql.Int, mealId)
            .query(`
                SELECT
                    (SELECT COUNT(*) FROM dbo.DayMeals WHERE MealID = @mealId) AS MenuReferences,
                    (SELECT COUNT(*) FROM dbo.Orders WHERE MealID = @mealId) AS OrderReferences,
                    (SELECT COUNT(*) FROM dbo.GuestOrders WHERE MealID = @mealId) AS GuestOrderReferences;
            `);

        const references = referenceResult.recordset[0];
        const referenceCount =
            Number(references.MenuReferences) +
            Number(references.OrderReferences) +
            Number(references.GuestOrderReferences);

        if (referenceCount > 0) {
            await transaction.rollback();
            transactionStarted = false;

            return {
                status: 409,
                jsonBody: {
                    error: 'Meal cannot be permanently deleted because it is used in menus or orders',
                    mealId,
                    referenceCount,
                    references: {
                        menus: Number(references.MenuReferences),
                        orders: Number(references.OrderReferences),
                        guestOrders: Number(references.GuestOrderReferences)
                    },
                    suggestion: 'Archive the meal instead'
                }
            };
        }

        const deleteResult = await new sql.Request(transaction)
            .input('mealId', sql.Int, mealId)
            .query(`
                DELETE FROM dbo.Meals
                OUTPUT DELETED.MealID
                WHERE MealID = @mealId;
            `);

        if (deleteResult.recordset.length === 0) {
            await transaction.rollback();
            transactionStarted = false;

            return {
                status: 404,
                jsonBody: {
                    error: `Meal ${mealId} does not exist`
                }
            };
        }

        await transaction.commit();
        transactionStarted = false;

        return {
            status: 200,
            jsonBody: {
                success: true,
                deleteType: 'hard',
                mealId
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

function validateMeal(body, isUpdate) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return {
            error: 'Request body must be a JSON object'
        };
    }

    const requiredFields = ['nameEN', 'nameSV', 'nameFI', 'category'];
    const missingFields = requiredFields.filter(field => {
        return typeof body[field] !== 'string' || body[field].trim() === '';
    });

    if (missingFields.length > 0) {
        return {
            error: `Missing or empty fields: ${missingFields.join(', ')}`
        };
    }

    const nameFields = ['nameEN', 'nameSV', 'nameFI'];
    const tooLongFields = nameFields.filter(field => body[field].trim().length > 200);

    if (tooLongFields.length > 0) {
        return {
            error: `Maximum name length is 200 characters: ${tooLongFields.join(', ')}`
        };
    }

    const category = normaliseCategory(body.category);

    if (!category) {
        return {
            error: `Category must be one of: ${[...VALID_CATEGORIES].join(', ')}`
        };
    }

    if (body.active !== undefined && typeof body.active !== 'boolean') {
        return {
            error: 'active must be true or false'
        };
    }

    return {
        meal: {
            nameEN: body.nameEN.trim(),
            nameSV: body.nameSV.trim(),
            nameFI: body.nameFI.trim(),
            category,
            active: body.active === undefined ? true : body.active
        }
    };
}

function normaliseCategory(value) {
    if (typeof value !== 'string') {
        return null;
    }

    const input = value.trim().toLowerCase();

    for (const category of VALID_CATEGORIES) {
        if (category.toLowerCase() === input) {
            return category;
        }
    }

    return null;
}

async function readJsonBody(request) {
    try {
        return {
            body: await request.json()
        };
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

function parseBoolean(value, defaultValue) {
    if (value === null || value === undefined || value === '') {
        return defaultValue;
    }

    return ['1', 'true', 'yes'].includes(String(value).toLowerCase());
}

function methodNotAllowed(allowedMethods) {
    return {
        status: 405,
        headers: {
            Allow: allowedMethods
        },
        jsonBody: {
            error: 'Method not allowed'
        }
    };
}

function serverError(context, message, error) {
    context.error(message, error);

    return {
        status: 500,
        jsonBody: {
            error: message,
            details: error.message
        }
    };
}
