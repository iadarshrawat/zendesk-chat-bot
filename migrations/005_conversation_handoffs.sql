SET XACT_ABORT ON;

BEGIN TRY
  BEGIN TRANSACTION;

  IF OBJECT_ID(N'[{{schema}}].[bot_conversation_handoffs]', N'U') IS NULL
  BEGIN
    CREATE TABLE [{{schema}}].[bot_conversation_handoffs] (
      [conversation_id] NVARCHAR(128) NOT NULL,
      [web_user_id] NVARCHAR(128) NOT NULL,
      [attempt_id] CHAR(36) NOT NULL,
      [status] VARCHAR(24) NOT NULL,
      [offer_message_id] NVARCHAR(128) NULL,
      [form_message_id] NVARCHAR(128) NULL,
      [data_json] NVARCHAR(MAX) NOT NULL,
      [revision] INT NOT NULL,
      [created_at] DATETIME2(3) NOT NULL,
      [updated_at] DATETIME2(3) NOT NULL,
      CONSTRAINT [PK_bot_conversation_handoffs]
        PRIMARY KEY CLUSTERED ([conversation_id], [web_user_id]),
      CONSTRAINT [CK_bot_conversation_handoffs_status] CHECK ([status] IN (
        'offer_sending', 'offer_pending', 'form_sending', 'form_pending',
        'form_submitted', 'transferring', 'transferred', 'transfer_unknown', 'failed', 'cancelled'
      )),
      CONSTRAINT [CK_bot_conversation_handoffs_data_json] CHECK (ISJSON([data_json]) = 1),
      CONSTRAINT [CK_bot_conversation_handoffs_revision] CHECK ([revision] > 0)
    );

    CREATE INDEX [idx_bot_handoff_updated]
      ON [{{schema}}].[bot_conversation_handoffs] ([updated_at]);
  END;

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
