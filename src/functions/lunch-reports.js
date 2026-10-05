const { app } = require('@azure/functions');
const sql = require('mssql');

app.http('lunch-reports', {
  methods: ['GET'], authLevel: 'anonymous', route: 'lunch-reports',
  handler: async (request, context) => {
    try {
      const url = new URL(request.url);
      const dateFrom = validDate(url.searchParams.get('dateFrom'));
      const dateTo = validDate(url.searchParams.get('dateTo'));
      if (!dateFrom || !dateTo) return response(400, { error: 'dateFrom and dateTo are required in YYYY-MM-DD format.' });
      if (dateFrom > dateTo) return response(400, { error: 'dateFrom cannot be later than dateTo.' });
      const pool = await sql.connect(process.env.SqlConnectionString);
      const hasManual = (await pool.request().query("SELECT CASE WHEN OBJECT_ID(N'dbo.ManualLunchAdjustments',N'U') IS NULL THEN 0 ELSE 1 END AS HasManual")).recordset[0].HasManual === 1;
      const employee = await employeeReport(pool, dateFrom, dateTo, hasManual);
      const external = await externalReport(pool, dateFrom, dateTo);
      const guests = await guestReport(pool, dateFrom, dateTo);
      return response(200, {
        dateFrom, dateTo,
        summary: {
          employeeLunches: employee.reduce((n,x)=>n+x.numberOfLunches,0),
          employeeCount: employee.length,
          externalLunches: external.reduce((n,x)=>n+x.numberOfLunches,0),
          externalAccountCount: external.length,
          guestLunches: guests.totalLunches
        },
        employees: employee, externalAccounts: external, guests,
        manualAdjustmentsAvailable: hasManual
      });
    } catch (error) {
      context.error('Lunch reports failed', error);
      return response(500, { error: 'Lunch reports request failed.', details: error.message });
    }
  }
});

async function employeeReport(pool, from, to, hasManual) {
  const manualCte = hasManual
    ? `Manual AS (SELECT EmployeeNo,SUM(Quantity) ManualLunches FROM dbo.ManualLunchAdjustments WHERE MenuDate BETWEEN @from AND @to GROUP BY EmployeeNo),`
    : `Manual AS (SELECT CAST(NULL AS int) EmployeeNo,CAST(0 AS int) ManualLunches WHERE 1=0),`;
  const result = await pool.request().input('from',sql.Date,from).input('to',sql.Date,to).query(`
    WITH MealCancel AS (
      SELECT OrderID,SUM(Quantity) Qty FROM dbo.OrderCancellations WHERE OrderType=N'Employee' GROUP BY OrderID
    ), Meals AS (
      SELECT o.EmployeeNo,SUM(CASE WHEN o.Quantity-COALESCE(c.Qty,0)>0 THEN o.Quantity-COALESCE(c.Qty,0) ELSE 0 END) MealLunches
      FROM dbo.Orders o LEFT JOIN MealCancel c ON c.OrderID=o.OrderID
      WHERE o.EmployeeNo IS NOT NULL AND o.MenuDate BETWEEN @from AND @to GROUP BY o.EmployeeNo
    ), SaladCancel AS (
      SELECT SaladOrderID,SUM(Quantity) Qty FROM dbo.SaladOrderCancellations WHERE OrderType=N'Employee' GROUP BY SaladOrderID
    ), Salads AS (
      SELECT o.EmployeeNo,SUM(CASE WHEN o.Quantity-COALESCE(c.Qty,0)>0 THEN o.Quantity-COALESCE(c.Qty,0) ELSE 0 END) SaladLunches
      FROM dbo.SaladOrders o LEFT JOIN SaladCancel c ON c.SaladOrderID=o.SaladOrderID
      WHERE o.EmployeeNo IS NOT NULL AND o.MenuDate BETWEEN @from AND @to GROUP BY o.EmployeeNo
    ), ${manualCte}
    Owners AS (SELECT EmployeeNo FROM Meals UNION SELECT EmployeeNo FROM Salads UNION SELECT EmployeeNo FROM Manual)
    SELECT e.EmployeeNo,e.FirstName,e.LastName,COALESCE(m.MealLunches,0) MealLunches,
           COALESCE(s.SaladLunches,0) SaladLunches,COALESCE(a.ManualLunches,0) ManualLunches,
           COALESCE(m.MealLunches,0)+COALESCE(s.SaladLunches,0)+COALESCE(a.ManualLunches,0) NumberOfLunches
    FROM Owners x INNER JOIN dbo.Employees e ON e.EmployeeNo=x.EmployeeNo
    LEFT JOIN Meals m ON m.EmployeeNo=x.EmployeeNo LEFT JOIN Salads s ON s.EmployeeNo=x.EmployeeNo LEFT JOIN Manual a ON a.EmployeeNo=x.EmployeeNo
    WHERE COALESCE(m.MealLunches,0)+COALESCE(s.SaladLunches,0)+COALESCE(a.ManualLunches,0)>0
    ORDER BY e.LastName,e.FirstName,e.EmployeeNo`);
  return result.recordset.map(x=>({employeeNo:x.EmployeeNo,firstName:x.FirstName||'',lastName:x.LastName||'',employeeName:[x.FirstName,x.LastName].filter(Boolean).join(' '),mealLunches:Number(x.MealLunches),saladLunches:Number(x.SaladLunches),manualLunches:Number(x.ManualLunches),numberOfLunches:Number(x.NumberOfLunches)}));
}

async function externalReport(pool, from, to) {
  const result = await pool.request().input('from',sql.Date,from).input('to',sql.Date,to).query(`
    WITH MealCancel AS (SELECT OrderID,SUM(Quantity) Qty FROM dbo.OrderCancellations WHERE OrderType=N'Employee' GROUP BY OrderID),
    Meals AS (SELECT o.ExternalAccountID,SUM(CASE WHEN o.Quantity-COALESCE(c.Qty,0)>0 THEN o.Quantity-COALESCE(c.Qty,0) ELSE 0 END) MealLunches FROM dbo.Orders o LEFT JOIN MealCancel c ON c.OrderID=o.OrderID WHERE o.ExternalAccountID IS NOT NULL AND o.MenuDate BETWEEN @from AND @to GROUP BY o.ExternalAccountID),
    SaladCancel AS (SELECT SaladOrderID,SUM(Quantity) Qty FROM dbo.SaladOrderCancellations WHERE OrderType=N'Employee' GROUP BY SaladOrderID),
    Salads AS (SELECT o.ExternalAccountID,SUM(CASE WHEN o.Quantity-COALESCE(c.Qty,0)>0 THEN o.Quantity-COALESCE(c.Qty,0) ELSE 0 END) SaladLunches FROM dbo.SaladOrders o LEFT JOIN SaladCancel c ON c.SaladOrderID=o.SaladOrderID WHERE o.ExternalAccountID IS NOT NULL AND o.MenuDate BETWEEN @from AND @to GROUP BY o.ExternalAccountID),
    Owners AS (SELECT ExternalAccountID FROM Meals UNION SELECT ExternalAccountID FROM Salads)
    SELECT a.ExternalAccountID,a.DisplayName,a.CompanyName,a.ExternalReference,a.InvoiceReference,COALESCE(m.MealLunches,0) MealLunches,COALESCE(s.SaladLunches,0) SaladLunches,COALESCE(m.MealLunches,0)+COALESCE(s.SaladLunches,0) NumberOfLunches
    FROM Owners x INNER JOIN dbo.ExternalAccounts a ON a.ExternalAccountID=x.ExternalAccountID
    LEFT JOIN Meals m ON m.ExternalAccountID=x.ExternalAccountID LEFT JOIN Salads s ON s.ExternalAccountID=x.ExternalAccountID
    WHERE COALESCE(m.MealLunches,0)+COALESCE(s.SaladLunches,0)>0 ORDER BY a.CompanyName,a.DisplayName,a.ExternalAccountID`);
  return result.recordset.map(x=>({externalAccountId:x.ExternalAccountID,displayName:x.DisplayName||'',companyName:x.CompanyName||'',externalReference:x.ExternalReference||'',invoiceReference:x.InvoiceReference||'',mealLunches:Number(x.MealLunches),saladLunches:Number(x.SaladLunches),numberOfLunches:Number(x.NumberOfLunches)}));
}

async function guestReport(pool, from, to) {
  const result = await pool.request().input('from',sql.Date,from).input('to',sql.Date,to).query(`
    WITH MealCancel AS (SELECT GuestOrderID,SUM(Quantity) Qty FROM dbo.OrderCancellations WHERE OrderType=N'Guest' GROUP BY GuestOrderID),
    MealTotal AS (SELECT SUM(CASE WHEN o.Quantity-COALESCE(c.Qty,0)>0 THEN o.Quantity-COALESCE(c.Qty,0) ELSE 0 END) Qty FROM dbo.GuestOrders o LEFT JOIN MealCancel c ON c.GuestOrderID=o.GuestOrderID WHERE o.MenuDate BETWEEN @from AND @to),
    SaladCancel AS (SELECT GuestSaladOrderID,SUM(Quantity) Qty FROM dbo.SaladOrderCancellations WHERE OrderType=N'Guest' GROUP BY GuestSaladOrderID),
    SaladTotal AS (SELECT SUM(CASE WHEN o.Quantity-COALESCE(c.Qty,0)>0 THEN o.Quantity-COALESCE(c.Qty,0) ELSE 0 END) Qty FROM dbo.GuestSaladOrders o LEFT JOIN SaladCancel c ON c.GuestSaladOrderID=o.GuestSaladOrderID WHERE o.MenuDate BETWEEN @from AND @to)
    SELECT COALESCE((SELECT Qty FROM MealTotal),0) MealLunches,COALESCE((SELECT Qty FROM SaladTotal),0) SaladLunches`);
  const x=result.recordset[0]; return {mealLunches:Number(x.MealLunches),saladLunches:Number(x.SaladLunches),totalLunches:Number(x.MealLunches)+Number(x.SaladLunches)};
}
function validDate(v){return typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)?v:null;}
function response(status,jsonBody){return {status,jsonBody};}
