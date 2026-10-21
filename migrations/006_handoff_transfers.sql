-- Keep verified transfer evidence after the conversation starts another handoff attempt.
SET XACT_ABORT ON;

BEGIN TRY
  BEGIN TRANSACTION;

  IF OBJECT_ID(N'[{{schema}}].[{{prefix}}bot_handoff_transfers]', N'U') IS NULL
  BEGIN
    CREATE TABLE [{{schema}}].[{{prefix}}bot_handoff_transfers] (
      [attempt_id] CHAR(36) NOT NULL,
      [conversation_id] NVARCHAR(128) NOT NULL,
      [web_user_id] NVARCHAR(128) NOT NULL,
      [source_message_id] NVARCHAR(128) NULL,
      [form_message_id] NVARCHAR(128) NULL,
      [transfer_started_at] DATETIME2(3) NOT NULL,
      [confirmed_at] DATETIME2(3) NOT NULL,
      [support_mode] VARCHAR(16) NOT NULL,
      CONSTRAINT [{{prefix}}PK_bot_handoff_transfers] PRIMARY KEY CLUSTERED ([attempt_id]),
      CONSTRAINT [{{prefix}}CK_bot_handoff_transfers_mode] CHECK ([support_mode] IN ('live', 'follow_up')),
      CONSTRAINT [{{prefix}}CK_bot_handoff_transfers_message] CHECK ([source_message_id] IS NOT NULL OR [form_message_id] IS NOT NULL)
    );

    CREATE INDEX [{{prefix}}idx_bot_handoff_source]
      ON [{{schema}}].[{{prefix}}bot_handoff_transfers] ([source_message_id]);
    CREATE INDEX [{{prefix}}idx_bot_handoff_form]
      ON [{{schema}}].[{{prefix}}bot_handoff_transfers] ([form_message_id]);
  END;

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
