const { app } = require('@azure/functions');
const sql = require('mssql');

app.http('manual-lunch-adjustments', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    route: 'manual-lunch-adjustments',
    handler: async (request, context) => {
        try {
            const pool = await sql.connect(process.env.SqlConnectionString);
            if (request.method === 'GET') return list(pool, request);
            return create(pool, request);
        } catch (error) {
            context.error('manual-lunch-adjustments failed', error);
            return { status: 500, jsonBody: { error: 'Manual lunch request failed', details: error.message } };
        }
    }
});

function dateOnly(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

async function list(pool, request) {
    const url = new URL(request.url);
    const employeeNo = Number(url.searchParams.get('employeeNo'));
    const dateFrom = dateOnly(url.searchParams.get('dateFrom')) || '1900-01-01';
    const dateTo = dateOnly(url.searchParams.get('dateTo')) || '9999-12-31';
    const db = pool.request().input('from', sql.Date, dateFrom).input('to', sql.Date, dateTo);
    let ownerFilter = '';
    if (Number.isInteger(employeeNo) && employeeNo > 0) {
        db.input('employeeNo', sql.Int, employeeNo);
        ownerFilter = ' AND a.EmployeeNo = @employeeNo';
    }
    const result = await db.query(`
        SELECT a.AdjustmentID, a.EmployeeNo, a.MenuDate, a.Quantity, a.Reason,
               a.CreatedBy, a.CreatedAt, e.FirstName, e.LastName
        FROM dbo.ManualLunchAdjustments a
        INNER JOIN dbo.Employees e ON e.EmployeeNo = a.EmployeeNo
        WHERE a.MenuDate BETWEEN @from AND @to${ownerFilter}
        ORDER BY a.MenuDate, e.LastName, e.FirstName, a.AdjustmentID`);
    return { status: 200, jsonBody: { adjustments: result.recordset } };
}

async function create(pool, request) {
    let body;
    try { body = await request.json(); }
    catch { return { status: 400, jsonBody: { error: 'Request body must contain valid JSON' } }; }
    const employeeNo = Number(body.employeeNo);
    const menuDate = dateOnly(body.menuDate);
    const quantity = Number(body.quantity ?? 1);
    const reason = body.reason == null ? null : String(body.reason).trim().slice(0, 250) || null;
    const createdBy = body.createdBy == null ? null : String(body.createdBy).trim().slice(0, 255) || null;
    if (!Number.isInteger(employeeNo) || employeeNo <= 0 || !menuDate || !Number.isInteger(quantity) || quantity < 1 || quantity > 50)
        return { status: 400, jsonBody: { error: 'employeeNo, menuDate and a quantity from 1 to 50 are required' } };
    const employee = await pool.request().input('employeeNo', sql.Int, employeeNo)
        .query('SELECT EmployeeNo FROM dbo.Employees WHERE EmployeeNo=@employeeNo AND COALESCE(Active,1)=1');
    if (!employee.recordset.length) return { status: 404, jsonBody: { error: 'Active employee not found' } };
    const result = await pool.request()
        .input('employeeNo', sql.Int, employeeNo).input('menuDate', sql.Date, menuDate)
        .input('quantity', sql.Int, quantity).input('reason', sql.NVarChar(250), reason)
        .input('createdBy', sql.NVarChar(255), createdBy)
        .query(`INSERT dbo.ManualLunchAdjustments(EmployeeNo,MenuDate,Quantity,Reason,CreatedBy)
                OUTPUT inserted.AdjustmentID,inserted.EmployeeNo,inserted.MenuDate,inserted.Quantity,inserted.Reason,inserted.CreatedBy,inserted.CreatedAt
                VALUES(@employeeNo,@menuDate,@quantity,@reason,@createdBy)`);
    return { status: 201, jsonBody: { success: true, adjustment: result.recordset[0] } };
}
