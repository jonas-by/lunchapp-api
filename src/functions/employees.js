const { app } = require('@azure/functions');
const sql = require('mssql');

app.http('employees', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'employees',

    handler: async (request, context) => {
        context.log('Reading employees from Azure SQL');

        try {
            const pool = await sql.connect(
                process.env.SqlConnectionString
            );

            const result = await pool.request().query(`
                SELECT
                    EmployeeNo,
                    FirstName,
                    LastName,
                    Email,
                    CardNumber,
                    Active
                FROM dbo.Employees
                ORDER BY EmployeeNo;
            `);

            return {
                status: 200,
                jsonBody: result.recordset
            };
        } catch (error) {
            context.error('Database query failed', error);

            return {
                status: 500,
                jsonBody: {
                    error: 'Database query failed',
                    details: error.message
                }
            };
        }
    }
});