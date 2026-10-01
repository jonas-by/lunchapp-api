SET XACT_ABORT ON;
GO
IF OBJECT_ID(N'dbo.SaladOrderCancellations', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.SaladOrderCancellations
    (
        SaladOrderCancellationID int IDENTITY(1,1) NOT NULL CONSTRAINT PK_SaladOrderCancellations PRIMARY KEY,
        OrderType nvarchar(20) NOT NULL,
        SaladOrderID int NULL,
        GuestSaladOrderID int NULL,
        Quantity int NOT NULL,
        ReasonCode nvarchar(50) NOT NULL,
        ReasonText nvarchar(500) NULL,
        CancelledBy nvarchar(100) NOT NULL,
        CancelledAt datetime2(0) NOT NULL CONSTRAINT DF_SaladOrderCancellations_CancelledAt DEFAULT SYSUTCDATETIME(),
        CONSTRAINT CK_SaladOrderCancellations_OrderType CHECK (OrderType IN (N'Employee',N'Guest')),
        CONSTRAINT CK_SaladOrderCancellations_Quantity CHECK (Quantity > 0),
        CONSTRAINT CK_SaladOrderCancellations_Source CHECK
        (
            (OrderType=N'Employee' AND SaladOrderID IS NOT NULL AND GuestSaladOrderID IS NULL)
            OR
            (OrderType=N'Guest' AND SaladOrderID IS NULL AND GuestSaladOrderID IS NOT NULL)
        ),
        CONSTRAINT FK_SaladOrderCancellations_Employee FOREIGN KEY (SaladOrderID) REFERENCES dbo.SaladOrders(SaladOrderID),
        CONSTRAINT FK_SaladOrderCancellations_Guest FOREIGN KEY (GuestSaladOrderID) REFERENCES dbo.GuestSaladOrders(GuestSaladOrderID)
    );
    CREATE INDEX IX_SaladOrderCancellations_Employee ON dbo.SaladOrderCancellations(SaladOrderID) WHERE SaladOrderID IS NOT NULL;
    CREATE INDEX IX_SaladOrderCancellations_Guest ON dbo.SaladOrderCancellations(GuestSaladOrderID) WHERE GuestSaladOrderID IS NOT NULL;
END;
GO
