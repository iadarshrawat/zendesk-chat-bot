-- Add a persistent, open-ended customer intent catalogue and session assignments.
-- Existing sessions remain pending until the explicit intent backfill is run.
SET XACT_ABORT ON;

BEGIN TRY
  BEGIN TRANSACTION;

  IF OBJECT_ID(N'[{{schema}}].[{{prefix}}bot_monitor_intents]', N'U') IS NULL
    CREATE TABLE [{{schema}}].[{{prefix}}bot_monitor_intents] (
      [intent_id] CHAR(64) NOT NULL,
      [name] NVARCHAR(240) NOT NULL,
      [product] NVARCHAR(160) NULL,
      [description] NVARCHAR(1000) NOT NULL,
      [created_at] DATETIME2(3) NOT NULL,
      CONSTRAINT [{{prefix}}PK_bot_monitor_intents] PRIMARY KEY CLUSTERED ([intent_id])
    );

  IF COL_LENGTH(N'[{{schema}}].[{{prefix}}bot_monitor_evaluations]', N'intent_id') IS NULL
    ALTER TABLE [{{schema}}].[{{prefix}}bot_monitor_evaluations] ADD [intent_id] CHAR(64) NULL;

  IF COL_LENGTH(N'[{{schema}}].[{{prefix}}bot_monitor_evaluations]', N'intent_classified_at') IS NULL
    ALTER TABLE [{{schema}}].[{{prefix}}bot_monitor_evaluations] ADD [intent_classified_at] DATETIME2(3) NULL;

  IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys
    WHERE parent_object_id = OBJECT_ID(N'[{{schema}}].[{{prefix}}bot_monitor_evaluations]')
      AND name = N'{{prefix}}FK_bot_monitor_evaluations_intent'
  )
    EXEC(N'ALTER TABLE [{{schema}}].[{{prefix}}bot_monitor_evaluations] WITH CHECK
      ADD CONSTRAINT [{{prefix}}FK_bot_monitor_evaluations_intent] FOREIGN KEY ([intent_id])
      REFERENCES [{{schema}}].[{{prefix}}bot_monitor_intents] ([intent_id]);');

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
