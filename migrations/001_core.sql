SET XACT_ABORT ON;

BEGIN TRY
  BEGIN TRANSACTION;

  IF SCHEMA_ID(N'{{schema}}') IS NULL
  BEGIN
    ;THROW 50001, 'Configured DB_SCHEMA does not exist', 1;
  END;

  IF OBJECT_ID(N'[{{schema}}].[bot_conversation_state]', N'U') IS NULL
  BEGIN
    CREATE TABLE [{{schema}}].[bot_conversation_state] (
      [conversation_id] NVARCHAR(128) NOT NULL,
      [state_json] NVARCHAR(MAX) NOT NULL,
      [updated_at] DATETIME2(3) NOT NULL,
      CONSTRAINT [PK_bot_conversation_state]
        PRIMARY KEY CLUSTERED ([conversation_id]),
      CONSTRAINT [CK_bot_conversation_state_state_json]
        CHECK (ISJSON([state_json]) = 1)
    );

    CREATE INDEX [idx_bot_state_updated]
      ON [{{schema}}].[bot_conversation_state] ([updated_at]);
  END;

  IF OBJECT_ID(N'[{{schema}}].[bot_monitor_sessions]', N'U') IS NULL
  BEGIN
    CREATE TABLE [{{schema}}].[bot_monitor_sessions] (
      [session_id] NVARCHAR(255) NOT NULL,
      [ticket_id] NVARCHAR(32) NOT NULL,
      [session_started_at] DATETIME2(3) NOT NULL,
      [last_customer_at] DATETIME2(3) NOT NULL,
      [record_external_id] NVARCHAR(255) NOT NULL,
      [evaluated_at] DATETIME2(3) NOT NULL,
      CONSTRAINT [PK_bot_monitor_sessions]
        PRIMARY KEY CLUSTERED ([session_id])
    );

    CREATE INDEX [idx_bot_monitor_ticket]
      ON [{{schema}}].[bot_monitor_sessions] ([ticket_id]);
  END;

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0
    ROLLBACK TRANSACTION;

  THROW;
END CATCH;
