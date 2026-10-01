const { app } = require('@azure/functions');
const sql = require('mssql');
const MAX_RANGE_DAYS = 366;

app.http('kitchen-orders', {
  methods: ['GET'], authLevel: 'anonymous', route: 'kitchen/orders',
  handler: async (request, context) => {
    const dateFrom=request.query.get('dateFrom'), dateTo=request.query.get('dateTo');
    if(!isIsoDate(dateFrom)||!isIsoDate(dateTo)) return bad('dateFrom and dateTo are required and must use YYYY-MM-DD format');
    if(dateFrom>dateTo) return bad('dateFrom cannot be later than dateTo');
    if(daysBetween(dateFrom,dateTo)+1>MAX_RANGE_DAYS) return bad(`Date range cannot exceed ${MAX_RANGE_DAYS} days`);
    try {
      const pool=await sql.connect(process.env.SqlConnectionString);
      const result=await pool.request().input('dateFrom',sql.Date,dateFrom).input('dateTo',sql.Date,dateTo).query(`
        WITH EC AS (SELECT OrderID,SUM(Quantity) CancelledQuantity FROM dbo.OrderCancellations WHERE OrderType=N'Employee' GROUP BY OrderID),
             GC AS (SELECT GuestOrderID,SUM(Quantity) CancelledQuantity FROM dbo.OrderCancellations WHERE OrderType=N'Guest' GROUP BY GuestOrderID)
        SELECT N'employee' OrderType,o.OrderID,CAST(NULL AS int) GuestOrderID,o.MenuDate,o.EmployeeNo,e.FirstName,e.LastName,
               o.OrderedMealID MealID,m.NameEN,m.NameSV,m.NameFI,m.Category,o.Quantity OriginalQuantity,
               COALESCE(ec.CancelledQuantity,0) CancelledQuantity,o.Quantity-COALESCE(ec.CancelledQuantity,0) ActiveQuantity,
               CAST(NULL AS nvarchar(200)) WorkTask,o.OrderTime
        FROM dbo.Orders o INNER JOIN dbo.Meals m ON m.MealID=o.OrderedMealID LEFT JOIN dbo.Employees e ON e.EmployeeNo=o.EmployeeNo LEFT JOIN EC ec ON ec.OrderID=o.OrderID
        WHERE o.MenuDate BETWEEN @dateFrom AND @dateTo AND o.Quantity-COALESCE(ec.CancelledQuantity,0)>0
        UNION ALL
        SELECT N'guest',CAST(NULL AS int),go.GuestOrderID,go.MenuDate,go.HostEmployeeNo,e.FirstName,e.LastName,
               go.OrderedMealID,m.NameEN,m.NameSV,m.NameFI,m.Category,go.Quantity,COALESCE(gc.CancelledQuantity,0),go.Quantity-COALESCE(gc.CancelledQuantity,0),go.WorkTask,go.OrderTime
        FROM dbo.GuestOrders go INNER JOIN dbo.Meals m ON m.MealID=go.OrderedMealID LEFT JOIN dbo.Employees e ON e.EmployeeNo=go.HostEmployeeNo LEFT JOIN GC gc ON gc.GuestOrderID=go.GuestOrderID
        WHERE go.MenuDate BETWEEN @dateFrom AND @dateTo AND go.Quantity-COALESCE(gc.CancelledQuantity,0)>0
        ORDER BY MenuDate,NameSV;

        SELECT N'employee' OrderType,so.SaladOrderID,CAST(NULL AS int) GuestSaladOrderID,so.MenuDate,so.EmployeeNo,e.FirstName,e.LastName,
               so.SaladID,s.NameEn,s.NameSv,s.NameFi,so.Quantity,CAST(NULL AS nvarchar(200)) WorkTask,so.OrderTime
        FROM dbo.SaladOrders so INNER JOIN dbo.Salads s ON s.SaladID=so.SaladID LEFT JOIN dbo.Employees e ON e.EmployeeNo=so.EmployeeNo
        WHERE so.MenuDate BETWEEN @dateFrom AND @dateTo
        UNION ALL
        SELECT N'guest',CAST(NULL AS int),gso.GuestSaladOrderID,gso.MenuDate,gso.HostEmployeeNo,e.FirstName,e.LastName,
               gso.SaladID,s.NameEn,s.NameSv,s.NameFi,gso.Quantity,gso.WorkTask,gso.OrderTime
        FROM dbo.GuestSaladOrders gso INNER JOIN dbo.Salads s ON s.SaladID=gso.SaladID LEFT JOIN dbo.Employees e ON e.EmployeeNo=gso.HostEmployeeNo
        WHERE gso.MenuDate BETWEEN @dateFrom AND @dateTo
        ORDER BY MenuDate,NameSv;
      `);
      const meals=(result.recordsets[0]||[]).map(mapMeal);
      const salads=(result.recordsets[1]||[]).map(mapSalad);
      const orders=[...meals,...salads];
      return {status:200,jsonBody:{dateFrom,dateTo,orders,totals:{meals:sum(meals),salads:sum(salads),portions:sum(orders),employeePortions:sum(orders.filter(x=>x.orderType==='employee')),guestPortions:sum(orders.filter(x=>x.orderType==='guest'))}}};
    } catch(error){context.error('Kitchen orders request failed',error);return {status:500,jsonBody:{error:'Kitchen orders request failed',details:error.message}};}
  }
});
function person(row){return [row.FirstName,row.LastName].filter(Boolean).join(' ')||`Employee ${row.EmployeeNo}`;}
function mapMeal(r){const q=Number(r.ActiveQuantity);return {itemType:'meal',orderType:r.OrderType,orderId:r.OrderID,guestOrderId:r.GuestOrderID,menuDate:fmt(r.MenuDate),employeeNo:r.EmployeeNo,employeeName:person(r),mealId:r.MealID,nameEN:r.NameEN,nameSV:r.NameSV,nameFI:r.NameFI,category:r.Category,quantity:q,originalQuantity:Number(r.OriginalQuantity),cancelledQuantity:Number(r.CancelledQuantity),activeQuantity:q,canCancel:q>0,workTask:r.WorkTask||null,orderTime:r.OrderTime};}
function mapSalad(r){const q=Number(r.Quantity);return {itemType:'salad',orderType:r.OrderType,saladOrderId:r.SaladOrderID,guestSaladOrderId:r.GuestSaladOrderID,menuDate:fmt(r.MenuDate),employeeNo:r.EmployeeNo,employeeName:person(r),mealId:`S${r.SaladID}`,saladId:r.SaladID,nameEN:r.NameEn,nameSV:r.NameSv,nameFI:r.NameFi,category:'Salad',quantity:q,originalQuantity:q,cancelledQuantity:0,activeQuantity:q,canCancel:false,workTask:r.WorkTask||null,orderTime:r.OrderTime};}
function sum(a){return a.reduce((n,x)=>n+Number(x.activeQuantity||x.quantity||0),0);}function fmt(v){return typeof v==='string'?v.slice(0,10):v.toISOString().slice(0,10);}function isIsoDate(v){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v))return false;const d=new Date(v+'T00:00:00Z');return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===v;}function daysBetween(a,z){return Math.floor((Date.parse(z+'T00:00:00Z')-Date.parse(a+'T00:00:00Z'))/86400000);}function bad(error){return {status:400,jsonBody:{error}};}
