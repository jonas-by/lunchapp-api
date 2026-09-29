const { app } = require('@azure/functions');
const sql = require('mssql');

app.http('employees', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    route: 'employees',
    handler: handleEmployees
});

app.http('employee-item', {
    methods: ['PUT', 'DELETE'],
    authLevel: 'anonymous',
    route: 'employees/{employeeNo}',
    handler: handleEmployeeItem
});

async function handleEmployees(request, context) {
    try {
        const pool = await sql.connect(process.env.SqlConnectionString);

        if (request.method === 'GET') {
            return await getEmployees(pool, request, context);
        }

        if (request.method === 'POST') {
            return await createEmployee(pool, request, context);
        }

        return methodNotAllowed('GET, POST');
    } catch (error) {
        return serverError(context, 'Employees request failed', error);
    }
}

async function handleEmployeeItem(request, context) {
    const employeeNo = parsePositiveInteger(request.params.employeeNo);

    if (!employeeNo) {
        return badRequest('employeeNo must be a positive integer');
    }

    try {
        const pool = await sql.connect(process.env.SqlConnectionString);

        if (request.method === 'PUT') {
            return await updateEmployee(pool, employeeNo, request, context);
        }

        if (request.method === 'DELETE') {
            return await deleteEmployee(pool, employeeNo, request, context);
        }

        return methodNotAllowed('PUT, DELETE');
    } catch (error) {
        return serverError(context, 'Employee request failed', error);
    }
}

async function getEmployees(pool, request, context) {
    const url = new URL(request.url);
    const includeInactive = parseBoolean(
        url.searchParams.get('includeInactive'),
        false
    );
    const search = String(url.searchParams.get('search') || '').trim();

    context.log(
        `Reading employees. includeInactive=${includeInactive}, search=${search || 'none'}`
    );

    const dbRequest = pool.request()
        .input('includeInactive', sql.Bit, includeInactive)
        .input('search', sql.NVarChar(255), search);

    const result = await dbRequest.query(`
        SELECT
            EmployeeNo,
            FirstName,
            LastName,
            Email,
            CardNumber,
            COALESCE(Active, 1) AS Active
        FROM dbo.Employees
        WHERE
            (@includeInactive = 1 OR COALESCE(Active, 1) = 1)
            AND
            (
                @search = ''
                OR CAST(EmployeeNo AS NVARCHAR(20)) LIKE '%' + @search + '%'
                OR COALESCE(CardNumber, '') LIKE '%' + @search + '%'
                OR COALESCE(FirstName, '') LIKE '%' + @search + '%'
                OR COALESCE(LastName, '') LIKE '%' + @search + '%'
                OR COALESCE(Email, '') LIKE '%' + @search + '%'
            )
        ORDER BY
            LastName,
            FirstName,
            EmployeeNo;
    `);

    return {
        status: 200,
        jsonBody: result.recordset
    };
}

async function createEmployee(pool, request, context) {
    const bodyResult = await readJsonBody(request);
    if (bodyResult.error) return bodyResult.error;

    const validation = validateEmployee(bodyResult.body, true);
    if (validation.error) return badRequest(validation.error);

    const employee = validation.employee;

    const duplicateResult = await pool.request()
        .input('employeeNo', sql.Int, employee.employeeNo)
        .input('cardNumber', sql.NVarChar(50), employee.cardNumber)
        .query(`
            SELECT TOP (1)
                EmployeeNo,
                FirstName,
                LastName,
                CardNumber,
                CASE
                    WHEN EmployeeNo = @employeeNo THEN 'employeeNo'
                    ELSE 'cardNumber'
                END AS DuplicateField
            FROM dbo.Employees
            WHERE EmployeeNo = @employeeNo
               OR (
                    @cardNumber IS NOT NULL
                    AND CardNumber = @cardNumber
               )
            ORDER BY CASE WHEN EmployeeNo = @employeeNo THEN 0 ELSE 1 END;
        `);

    if (duplicateResult.recordset.length > 0) {
        const duplicate = duplicateResult.recordset[0];

        const field = duplicate.DuplicateField;
        const value = field === 'employeeNo'
            ? String(employee.employeeNo)
            : employee.cardNumber;
        return duplicateValueResponse(field, value, duplicate);
    }

    context.log(`Creating employee ${employee.employeeNo}`);

    const result = await pool.request()
        .input('employeeNo', sql.Int, employee.employeeNo)
        .input('firstName', sql.NVarChar(100), employee.firstName)
        .input('lastName', sql.NVarChar(100), employee.lastName)
        .input('email', sql.NVarChar(255), employee.email)
        .input('cardNumber', sql.NVarChar(50), employee.cardNumber)
        .input('active', sql.Bit, employee.active)
        .query(`
            INSERT INTO dbo.Employees
            (
                EmployeeNo,
                FirstName,
                LastName,
                Email,
                CardNumber,
                Active
            )
            OUTPUT
                INSERTED.EmployeeNo,
                INSERTED.FirstName,
                INSERTED.LastName,
                INSERTED.Email,
                INSERTED.CardNumber,
                INSERTED.Active
            VALUES
            (
                @employeeNo,
                @firstName,
                @lastName,
                @email,
                @cardNumber,
                @active
            );
        `);

    return {
        status: 201,
        headers: {
            Location: `/api/employees/${employee.employeeNo}`
        },
        jsonBody: result.recordset[0]
    };
}

async function updateEmployee(pool, employeeNo, request, context) {
    const bodyResult = await readJsonBody(request);
    if (bodyResult.error) return bodyResult.error;

    const validation = validateEmployee(bodyResult.body, false);
    if (validation.error) return badRequest(validation.error);

    const employee = validation.employee;

    if (
        bodyResult.body.employeeNo !== undefined &&
        Number(bodyResult.body.employeeNo) !== employeeNo
    ) {
        return badRequest(
            'Employee number cannot be changed through this endpoint. Create a new employee or migrate the key separately.'
        );
    }

    if (employee.cardNumber !== null) {
        const cardResult = await pool.request()
            .input('employeeNo', sql.Int, employeeNo)
            .input('cardNumber', sql.NVarChar(50), employee.cardNumber)
            .query(`
                SELECT TOP (1)
                    EmployeeNo,
                    FirstName,
                    LastName,
                    CardNumber
                FROM dbo.Employees
                WHERE CardNumber = @cardNumber
                  AND EmployeeNo <> @employeeNo;
            `);

        if (cardResult.recordset.length > 0) {
            return duplicateValueResponse(
                'cardNumber',
                employee.cardNumber,
                cardResult.recordset[0]
            );
        }
    }

    context.log(`Updating employee ${employeeNo}`);

    const result = await pool.request()
        .input('employeeNo', sql.Int, employeeNo)
        .input('firstName', sql.NVarChar(100), employee.firstName)
        .input('lastName', sql.NVarChar(100), employee.lastName)
        .input('email', sql.NVarChar(255), employee.email)
        .input('cardNumber', sql.NVarChar(50), employee.cardNumber)
        .input('active', sql.Bit, employee.active)
        .query(`
            UPDATE dbo.Employees
            SET
                FirstName = @firstName,
                LastName = @lastName,
                Email = @email,
                CardNumber = @cardNumber,
                Active = @active
            OUTPUT
                INSERTED.EmployeeNo,
                INSERTED.FirstName,
                INSERTED.LastName,
                INSERTED.Email,
                INSERTED.CardNumber,
                INSERTED.Active
            WHERE EmployeeNo = @employeeNo;
        `);

    if (result.recordset.length === 0) {
        return notFound(`Employee ${employeeNo} does not exist`);
    }

    return {
        status: 200,
        jsonBody: result.recordset[0]
    };
}

async function deleteEmployee(pool, employeeNo, request, context) {
    const url = new URL(request.url);
    const hardDelete = parseBoolean(url.searchParams.get('hard'), false);

    if (!hardDelete) {
        context.log(`Soft-deleting employee ${employeeNo}`);

        const result = await pool.request()
            .input('employeeNo', sql.Int, employeeNo)
            .query(`
                UPDATE dbo.Employees
                SET Active = 0
                OUTPUT
                    INSERTED.EmployeeNo,
                    INSERTED.FirstName,
                    INSERTED.LastName,
                    INSERTED.Email,
                    INSERTED.CardNumber,
                    INSERTED.Active
                WHERE EmployeeNo = @employeeNo;
            `);

        if (result.recordset.length === 0) {
            return notFound(`Employee ${employeeNo} does not exist`);
        }

        return {
            status: 200,
            jsonBody: {
                success: true,
                deleteType: 'soft',
                employee: result.recordset[0]
            }
        };
    }

    context.log(`Permanently deleting employee ${employeeNo}`);

    const referenceResult = await pool.request()
        .input('employeeNo', sql.Int, employeeNo)
        .query(`
            SELECT
                (SELECT COUNT(*) FROM dbo.Orders
                 WHERE EmployeeNo = @employeeNo) AS PersonalOrderCount,
                (SELECT COUNT(*) FROM dbo.GuestOrders
                 WHERE HostEmployeeNo = @employeeNo) AS GuestOrderCount;
        `);

    const references = referenceResult.recordset[0];
    const totalReferences =
        references.PersonalOrderCount + references.GuestOrderCount;

    if (totalReferences > 0) {
        return {
            status: 409,
            jsonBody: {
                error: 'Employee cannot be permanently deleted because order history exists',
                employeeNo,
                personalOrderCount: references.PersonalOrderCount,
                guestOrderCount: references.GuestOrderCount,
                suggestion: 'Use DELETE without ?hard=true to deactivate the employee instead'
            }
        };
    }

    const result = await pool.request()
        .input('employeeNo', sql.Int, employeeNo)
        .query(`
            DELETE FROM dbo.Employees
            OUTPUT DELETED.EmployeeNo
            WHERE EmployeeNo = @employeeNo;
        `);

    if (result.recordset.length === 0) {
        return notFound(`Employee ${employeeNo} does not exist`);
    }

    return {
        status: 200,
        jsonBody: {
            success: true,
            deleteType: 'hard',
            employeeNo
        }
    };
}

function validateEmployee(body, requireEmployeeNo) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { error: 'Request body must be a JSON object' };
    }

    const employeeNo = requireEmployeeNo
        ? parsePositiveInteger(body.employeeNo)
        : null;

    if (requireEmployeeNo && !employeeNo) {
        return { error: 'employeeNo must be a positive integer' };
    }

    const firstName = normaliseNullableString(body.firstName);
    const lastName = normaliseNullableString(body.lastName);
    const email = normaliseNullableString(body.email);
    const cardNumber = normaliseNullableString(body.cardNumber);

    if (firstName && firstName.length > 100) {
        return { error: 'firstName cannot exceed 100 characters' };
    }

    if (lastName && lastName.length > 100) {
        return { error: 'lastName cannot exceed 100 characters' };
    }

    if (email && email.length > 255) {
        return { error: 'email cannot exceed 255 characters' };
    }

    if (cardNumber && cardNumber.length > 50) {
        return { error: 'cardNumber cannot exceed 50 characters' };
    }

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { error: 'email must contain a valid email address' };
    }

    if (body.active !== undefined && typeof body.active !== 'boolean') {
        return { error: 'active must be true or false' };
    }

    return {
        employee: {
            employeeNo,
            firstName,
            lastName,
            email,
            cardNumber,
            active: body.active === undefined ? true : body.active
        }
    };
}

function normaliseNullableString(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') return null;

    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
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

function parseBoolean(value, defaultValue) {
    if (value === null || value === undefined || value === '') {
        return defaultValue;
    }

    return ['1', 'true', 'yes'].includes(String(value).toLowerCase());
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

function duplicateValueResponse(field, value, employee) {
    const employeeName = [employee.FirstName, employee.LastName]
        .filter(Boolean)
        .join(' ') || `employee ${employee.EmployeeNo}`;
    const label = field === 'employeeNo' ? 'Employee number' : 'Card number';
    return {
        status: 409,
        jsonBody: {
            code: 'DUPLICATE_EMPLOYEE_VALUE',
            field,
            value,
            employeeNo: employee.EmployeeNo,
            employeeName,
            error: `${label} ${value} is already assigned to ${employeeName}.`
        }
    };
}
function badRequest(message) {
    return {
        status: 400,
        jsonBody: { error: message }
    };
}

function notFound(message) {
    return {
        status: 404,
        jsonBody: { error: message }
    };
}

function methodNotAllowed(allowedMethods) {
    return {
        status: 405,
        headers: { Allow: allowedMethods },
        jsonBody: { error: 'Method not allowed' }
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
