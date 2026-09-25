const { app } = require('@azure/functions');
const sql = require('mssql');

app.http('meals', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'meals',

    handler: async (request, context) => {
        context.log('Reading meals from Azure SQL');

        try {
            const pool = await sql.connect(
                process.env.SqlConnectionString
            );

            const result = await pool.request().query(`
                SELECT
                    *
                FROM dbo.Meals
                ORDER BY NameSV;
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