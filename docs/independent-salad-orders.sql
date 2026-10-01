SET XACT_ABORT ON;
BEGIN TRANSACTION;

/* Remove the earlier experimental SaladID columns. No production data is expected in DEV. */
IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name=N'FK_Orders_Salads') ALTER TABLE dbo.Orders DROP CONSTRAINT FK_Orders_Salads;
IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name=N'FK_GuestOrders_Salads') ALTER TABLE dbo.GuestOrders DROP CONSTRAINT FK_GuestOrders_Salads;
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'dbo.Orders') AND name=N'IX_Orders_SaladID') DROP INDEX IX_Orders_SaladID ON dbo.Orders;
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'dbo.GuestOrders') AND name=N'IX_GuestOrders_SaladID') DROP INDEX IX_GuestOrders_SaladID ON dbo.GuestOrders;
IF COL_LENGTH(N'dbo.Orders',N'SaladID') IS NOT NULL ALTER TABLE dbo.Orders DROP COLUMN SaladID;
IF COL_LENGTH(N'dbo.GuestOrders',N'SaladID') IS NOT NULL ALTER TABLE dbo.GuestOrders DROP COLUMN SaladID;

IF OBJECT_ID(N'dbo.SaladOrders',N'U') IS NULL
BEGIN
 CREATE TABLE dbo.SaladOrders(
  SaladOrderID int IDENTITY(1,1) NOT NULL CONSTRAINT PK_SaladOrders PRIMARY KEY,
  EmployeeNo int NOT NULL,
  MenuDate date NOT NULL,
  SaladID int NOT NULL,
  Quantity int NOT NULL,
  OrderTime datetime2(0) NOT NULL CONSTRAINT DF_SaladOrders_OrderTime DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_SaladOrders_Salads FOREIGN KEY(SaladID) REFERENCES dbo.Salads(SaladID),
  CONSTRAINT CK_SaladOrders_Quantity CHECK(Quantity BETWEEN 1 AND 50),
  CONSTRAINT UQ_SaladOrders_EmployeeDateSalad UNIQUE(EmployeeNo,MenuDate,SaladID)
 );
 CREATE INDEX IX_SaladOrders_Date ON dbo.SaladOrders(MenuDate) INCLUDE(EmployeeNo,SaladID,Quantity);
END;

IF OBJECT_ID(N'dbo.GuestSaladOrders',N'U') IS NULL
BEGIN
 CREATE TABLE dbo.GuestSaladOrders(
  GuestSaladOrderID int IDENTITY(1,1) NOT NULL CONSTRAINT PK_GuestSaladOrders PRIMARY KEY,
  HostEmployeeNo int NOT NULL,
  MenuDate date NOT NULL,
  SaladID int NOT NULL,
  Quantity int NOT NULL,
  WorkTask nvarchar(200) NOT NULL,
  OrderTime datetime2(0) NOT NULL CONSTRAINT DF_GuestSaladOrders_OrderTime DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_GuestSaladOrders_Salads FOREIGN KEY(SaladID) REFERENCES dbo.Salads(SaladID),
  CONSTRAINT CK_GuestSaladOrders_Quantity CHECK(Quantity BETWEEN 1 AND 50),
  CONSTRAINT UQ_GuestSaladOrders_HostDateSalad UNIQUE(HostEmployeeNo,MenuDate,SaladID)
 );
 CREATE INDEX IX_GuestSaladOrders_Date ON dbo.GuestSaladOrders(MenuDate) INCLUDE(HostEmployeeNo,SaladID,Quantity,WorkTask);
END;

COMMIT TRANSACTION;
GO
