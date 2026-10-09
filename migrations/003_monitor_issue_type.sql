-- Add one nullable category column. Existing sessions remain unclassified.
-- Run only through the explicitly confirmed database migration command.
SET XACT_ABORT ON;

BEGIN TRY
  BEGIN TRANSACTION;

  IF COL_LENGTH(N'[{{schema}}].[bot_monitor_evaluations]', N'issue_type') IS NULL
    ALTER TABLE [{{schema}}].[bot_monitor_evaluations]
      ADD [issue_type] VARCHAR(32) NULL;

  IF NOT EXISTS (
    SELECT 1 FROM sys.check_constraints
    WHERE parent_object_id = OBJECT_ID(N'[{{schema}}].[bot_monitor_evaluations]')
      AND name = N'CK_bot_monitor_evaluations_issue_type'
  )
    -- Compile this check only after SQL Server has added the new column above.
    EXEC(N'ALTER TABLE [{{schema}}].[bot_monitor_evaluations] WITH CHECK
      ADD CONSTRAINT [CK_bot_monitor_evaluations_issue_type] CHECK (
        [issue_type] IS NULL OR [issue_type] IN (
          ''product_information'', ''order_status'', ''delivery'', ''returns_refunds'',
          ''payment'', ''account'', ''technical_support'', ''other'', ''unknown''
        )
      );');

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
