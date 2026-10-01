SET XACT_ABORT ON;
GO

IF COL_LENGTH(N'dbo.Orders', N'SaladID') IS NULL
    ALTER TABLE dbo.Orders ADD SaladID int NULL;
GO
IF COL_LENGTH(N'dbo.GuestOrders', N'SaladID') IS NULL
    ALTER TABLE dbo.GuestOrders ADD SaladID int NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_Orders_Salads')
    ALTER TABLE dbo.Orders WITH CHECK
    ADD CONSTRAINT FK_Orders_Salads FOREIGN KEY (SaladID) REFERENCES dbo.Salads (SaladID);
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'FK_GuestOrders_Salads')
    ALTER TABLE dbo.GuestOrders WITH CHECK
    ADD CONSTRAINT FK_GuestOrders_Salads FOREIGN KEY (SaladID) REFERENCES dbo.Salads (SaladID);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.Orders') AND name = N'IX_Orders_SaladID')
    CREATE INDEX IX_Orders_SaladID ON dbo.Orders (SaladID) WHERE SaladID IS NOT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.GuestOrders') AND name = N'IX_GuestOrders_SaladID')
    CREATE INDEX IX_GuestOrders_SaladID ON dbo.GuestOrders (SaladID) WHERE SaladID IS NOT NULL;
GO
