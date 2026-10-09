SET XACT_ABORT ON;

BEGIN TRY
  BEGIN TRANSACTION;

  IF OBJECT_ID(N'[{{schema}}].[bot_monitor_evaluations]', N'U') IS NULL
  BEGIN
    CREATE TABLE [{{schema}}].[bot_monitor_evaluations] (
      [session_id] NVARCHAR(255) NOT NULL,
      [session_number] INT NOT NULL,
      [ticket_subject] NVARCHAR(1024) NOT NULL,
      [ticket_created_at] DATETIME2(3) NULL,
      [ticket_requester_id] NVARCHAR(128) NULL,
      [first_message_id] NVARCHAR(128) NOT NULL,
      [last_message_at] DATETIME2(3) NOT NULL,
      [message_count] INT NOT NULL,
      [evaluation_due_at] DATETIME2(3) NOT NULL,
      [report_date] DATE NOT NULL,
      [csat_score] VARCHAR(32) NOT NULL,
      [reason] NVARCHAR(4000) NOT NULL,
      [monitoring_status] VARCHAR(16) NOT NULL,
      [confidence] VARCHAR(8) NULL,
      [human_required] BIT NULL,
      [follow_up_required] BIT NULL,
      [key_issue] NVARCHAR(1024) NULL,
      [updated_at] DATETIME2(3) NOT NULL,
      [issue_type] VARCHAR(32) NULL,
      CONSTRAINT [PK_bot_monitor_evaluations] PRIMARY KEY CLUSTERED ([session_id]),
      CONSTRAINT [FK_bot_monitor_evaluations_session] FOREIGN KEY ([session_id])
        REFERENCES [{{schema}}].[bot_monitor_sessions] ([session_id]),
      CONSTRAINT [CK_bot_monitor_evaluations_score] CHECK (
        [csat_score] IN ('satisfied', 'neutral', 'unsatisfied', 'escalated', 'insufficient_data')
      ),
      CONSTRAINT [CK_bot_monitor_evaluations_status] CHECK (
        [monitoring_status] IN ('evaluated', 'escalated')
      ),
      CONSTRAINT [CK_bot_monitor_evaluations_confidence] CHECK (
        [confidence] IS NULL OR [confidence] IN ('high', 'medium', 'low')
      ),
      CONSTRAINT [CK_bot_monitor_evaluations_counts] CHECK (
        [session_number] >= 1 AND [message_count] >= 0
      ),
      CONSTRAINT [CK_bot_monitor_evaluations_issue_type] CHECK (
        [issue_type] IS NULL OR [issue_type] IN (
          'product_information', 'order_status', 'delivery', 'returns_refunds',
          'payment', 'account', 'technical_support', 'other', 'unknown'
        )
      )
    );

    CREATE INDEX [idx_bot_monitor_report]
      ON [{{schema}}].[bot_monitor_evaluations]
        ([report_date] DESC, [updated_at] DESC, [session_id] DESC);
  END;

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
  THROW;
END CATCH;
