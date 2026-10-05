const { app } = require('@azure/functions');
const sql = require('mssql');

app.http('orders', {
  methods: ['GET', 'PUT'], authLevel: 'anonymous', route: 'orders',
  handler: async (request, context) => {
    try {
      const pool = await sql.connect(process.env.SqlConnectionString);
      return request.method === 'GET' ? getOrders(pool, request) : putOrders(pool, request);
    } catch (error) {
      context.error('Orders request failed', error);
      return { status: 500, jsonBody: { error: 'Orders request failed', details: error.message } };
    }
  }
});

function pos(v) { const n=Number(v); return Number.isInteger(n)&&n>0?n:null; }
function iso(v) { return typeof v==='string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null; }
function fmt(v) { return v instanceof Date ? v.toISOString().slice(0,10) : String(v).slice(0,10); }
function bad(error, extra={}) { return { status:400, jsonBody:{error,...extra} }; }
function ownerFrom(source) {
  const employeeNo=pos(source.employeeNo), externalAccountId=pos(source.externalAccountId ?? source.externalAccountID);
  if ((employeeNo?1:0)+(externalAccountId?1:0)!==1) return {error:'Supply exactly one of employeeNo or externalAccountId'};
  return employeeNo ? {type:'employee', employeeNo, column:'EmployeeNo', value:employeeNo} : {type:'external', externalAccountId, column:'ExternalAccountID', value:externalAccountId};
}
async function validateOwner(pool,o){
  if(o.type==='employee') return (await pool.request().input('id',sql.Int,o.value).query('SELECT 1 AS ok FROM dbo.Employees WHERE EmployeeNo=@id AND COALESCE(Active,1)=1')).recordset.length>0;
  return (await pool.request().input('id',sql.Int,o.value).query(`SELECT 1 AS ok FROM dbo.ExternalAccounts WHERE ExternalAccountID=@id AND IsActive=1 AND (ValidFrom IS NULL OR ValidFrom<=CAST(GETDATE() AS date)) AND (ValidUntil IS NULL OR ValidUntil>=CAST(GETDATE() AS date))`)).recordset.length>0;
}
async function getOrders(pool,request){
  const u=new URL(request.url), o=ownerFrom(Object.fromEntries(u.searchParams)); if(o.error)return bad(o.error);
  const from=iso(u.searchParams.get('dateFrom')),to=iso(u.searchParams.get('dateTo'));
  if(u.searchParams.get('dateFrom')&&!from)return bad('dateFrom must use YYYY-MM-DD format');
  if(u.searchParams.get('dateTo')&&!to)return bad('dateTo must use YYYY-MM-DD format');
  if(from&&to&&from>to)return bad('dateFrom cannot be later than dateTo');
  const q=pool.request().input('ownerId',sql.Int,o.value).input('from',sql.Date,from||'1900-01-01').input('to',sql.Date,to||'9999-12-31');
  const r=await q.query(`SELECT x.OrderID,x.EmployeeNo,x.ExternalAccountID,x.MenuDate,x.OrderedMealID AS MealID,x.Quantity AS OriginalQuantity,COALESCE(c.CancelledQuantity,0) AS CancelledQuantity,x.Quantity-COALESCE(c.CancelledQuantity,0) AS Quantity,x.OrderTime,m.NameEN,m.NameSV,m.NameFI,m.Category FROM dbo.Orders x INNER JOIN dbo.Meals m ON m.MealID=x.OrderedMealID OUTER APPLY(SELECT SUM(Quantity) CancelledQuantity FROM dbo.OrderCancellations WHERE OrderType=N'Employee' AND OrderID=x.OrderID)c WHERE x.${o.column}=@ownerId AND x.MenuDate BETWEEN @from AND @to AND x.Quantity-COALESCE(c.CancelledQuantity,0)>0 ORDER BY x.MenuDate,m.NameSV`);
  return {status:200,jsonBody:{ownerType:o.type,employeeNo:o.employeeNo||null,externalAccountId:o.externalAccountId||null,dateFrom:from,dateTo:to,orders:r.recordset.map(x=>({orderId:x.OrderID,employeeNo:x.EmployeeNo,externalAccountId:x.ExternalAccountID,menuDate:fmt(x.MenuDate),mealId:x.MealID,quantity:x.Quantity,originalQuantity:x.OriginalQuantity,cancelledQuantity:Number(x.CancelledQuantity),orderTime:x.OrderTime,nameEN:x.NameEN,nameSV:x.NameSV,nameFI:x.NameFI,category:x.Category}))}};
}
async function putOrders(pool,request){
  let b; try{b=await request.json()}catch{return bad('Request body must contain valid JSON')}
  const o=ownerFrom(b); if(o.error)return bad(o.error); const from=iso(b.dateFrom),to=iso(b.dateTo);
  if(!from||!to||from>to||!Array.isArray(b.orders))return bad('Invalid date range or orders array');
  if(!await validateOwner(pool,o))return bad(o.type==='employee'?'Employee does not exist or is inactive':'External account does not exist, is inactive, or is outside its validity period');
  const map=new Map(); for(const x of b.orders){const d=iso(x.menuDate),id=pos(x.mealId),q=pos(x.quantity);if(!d||d<from||d>to||!id||!q||q>50)return bad('Invalid order');const k=d+':'+id,old=map.get(k);map.set(k,{menuDate:d,mealId:id,quantity:(old?.quantity||0)+q});}
  const lines=[...map.values()]; if(lines.some(x=>x.quantity>50))return bad('Combined quantity cannot exceed 50');
  const ids=[...new Set(lines.map(x=>x.mealId))]; if(ids.length){const rq=pool.request(),ps=ids.map((id,i)=>(rq.input('m'+i,sql.Int,id),'@m'+i));const found=await rq.query(`SELECT MealID FROM dbo.Meals WHERE MealID IN (${ps.join(',')})`);const ok=new Set(found.recordset.map(x=>x.MealID));if(ids.some(id=>!ok.has(id)))return bad('One or more submitted meals do not exist');}
  const tx=new sql.Transaction(pool); await tx.begin(); try{
    const existing=await new sql.Request(tx).input('ownerId',sql.Int,o.value).input('from',sql.Date,from).input('to',sql.Date,to).query(`SELECT x.OrderID,x.MenuDate,x.OrderedMealID AS MealID,COALESCE(SUM(c.Quantity),0) CancelledQuantity FROM dbo.Orders x LEFT JOIN dbo.OrderCancellations c ON c.OrderType=N'Employee' AND c.OrderID=x.OrderID WHERE x.${o.column}=@ownerId AND x.MenuDate BETWEEN @from AND @to GROUP BY x.OrderID,x.MenuDate,x.OrderedMealID`);
    const wanted=new Set(lines.map(x=>x.menuDate+'|'+x.mealId)); for(const e of existing.recordset){if(!wanted.has(fmt(e.MenuDate)+'|'+e.MealID)&&Number(e.CancelledQuantity)===0)await new sql.Request(tx).input('id',sql.Int,e.OrderID).query('DELETE dbo.Orders WHERE OrderID=@id');}
    for(const x of lines){const e=existing.recordset.find(y=>fmt(y.MenuDate)===x.menuDate&&Number(y.MealID)===x.mealId);if(e)await new sql.Request(tx).input('id',sql.Int,e.OrderID).input('q',sql.Int,x.quantity+Number(e.CancelledQuantity)).query('UPDATE dbo.Orders SET Quantity=@q,OrderTime=SYSUTCDATETIME() WHERE OrderID=@id');else await new sql.Request(tx).input('employeeNo',sql.Int,o.employeeNo||null).input('externalAccountId',sql.Int,o.externalAccountId||null).input('d',sql.Date,x.menuDate).input('m',sql.Int,x.mealId).input('q',sql.Int,x.quantity).query('INSERT dbo.Orders(EmployeeNo,ExternalAccountID,MenuDate,OrderedMealID,Quantity) VALUES(@employeeNo,@externalAccountId,@d,@m,@q)');}
    await tx.commit(); return {status:200,jsonBody:{success:true,ownerType:o.type,employeeNo:o.employeeNo||null,externalAccountId:o.externalAccountId||null,orderLines:lines.length,totalLunches:lines.reduce((a,x)=>a+x.quantity,0)}};
  }catch(e){await tx.rollback();throw e}
}