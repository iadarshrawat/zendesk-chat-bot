# Project flows by customer and operations case

## 1. Overall runtime

```mermaid
flowchart TD
    Customer[Customer in Web Widget] --> Zendesk[Zendesk messaging]
    Zendesk --> Web[Express API and background loops]
    Web --> Inbox[In-memory inbox]
    Inbox --> Worker[In-process inbox loop]
    Worker --> RAG[Knowledge and Claude]
    RAG --> Cosmos[(Cosmos knowledge)]
    Worker --> Gateway[Sunshine message gateway]
    Gateway --> Zendesk
    Web --> Monitor[Five-minute monitor]
    Monitor --> Tickets[Zendesk tickets and custom objects]
```

The API acknowledges events after they enter the current process's bounded memory queue. It then wakes the inbox loop in the same `npm start` process. Queued events and recent duplicate IDs are lost on restart; another app instance has a separate queue. The monitoring loop runs independently. A unique event key deduplicates redeliveries while that key remains in memory.

## 2. New conversation and welcome

```mermaid
flowchart TD
    A[conversation:create webhook] --> B{Secret and app ID valid?}
    B -- No --> C[Reject request]
    B -- Yes --> D[Queue event in process memory]
    D --> E[Worker resolves brandId]
    E --> F{Known brand?}
    F -- Yes --> G[Send welcome through gateway]
    F -- No --> H[Record failure for review]
```

The brand ID must match `WIDGET_ID_MR_BRAND` or `WIDGET_ID_COMFORT_ZONE`. Unknown brands never search a different brand's knowledge.

## 3. Normal question or FAQ

```mermaid
flowchart TD
    A[Customer message] --> B{Agent already in control?}
    B -- Yes --> C[Ignore bot turn]
    B -- No --> D{Explicit agent request?}
    D -- Yes --> E[Escalation flow]
    D -- No --> F[Load history and case state]
    F --> G[Plan query and retrieve brand evidence]
    G --> H[Claude drafts structured reply]
    H --> I{Evidence and reply valid?}
    I -- Yes --> J[Send one answer]
    I -- No --> K[Recovery or focused fallback]
    K --> J
```

The question path does not send a progress message. The original retrieval, evidence-label validation and citation audit remain. Greetings and basic information requests bypass the escalation classifier when the heuristic identifies them. The answer model still runs for conversational turns. A generation timeout sends one operational fallback; a failed Sunshine POST is tracked by the inbox.

## 4. Customer follow-up in the same conversation

```mermaid
flowchart TD
    A[Later customer message] --> B[Inbox orders events per conversation]
    B --> C[Load earlier messages]
    C --> D[Load SQL Server case state]
    D --> E{New topic?}
    E -- No --> F[Use previous case details]
    E -- Yes --> G[Start a fresh case plan]
    F --> H[Retrieve and answer]
    G --> H
    H --> I[Send answer and save state]
```

A follow-up such as “that did not work” can refer to a prior bot answer. Case state survives a web process restart. Customer-visible text is sent once per turn through the gateway.

## 5. Agent handoff and after-hours form

```mermaid
flowchart TD
    A[Agent request] --> B[Fetch categories and office hours]
    B --> C[Send detail form]
    C --> D[Save form with expiry in process memory]
    D --> E[Customer submits name, email, category, issue]
    E --> F{Within business hours?}
    F -- Yes --> G[Ask for handoff confirmation]
    G --> H{Customer confirms?}
    H -- No --> I[Delete form and continue bot]
    H -- Yes --> J[passControl to Agent Workspace]
    F -- No --> J
    J --> K[Send handoff message and delete form]
```

The category maps to a Zendesk group ID only when it is numeric. When no category object is configured, the form offers general support. The handoff `passControl` uses an explicit integration name and is idempotent at Zendesk; it precedes the final confirmation message. Agent-authored messages and agent-owned conversations are not answered by the bot.
Form data expires after 30 minutes and is lost if the app restarts; it is not shared between app instances.

## 6. Authenticated widget user

```mermaid
flowchart TD
    A[Logged-in website] --> B[Send website session JWT]
    B --> C[Verify RS256 JWKS, issuer, audience, expiry]
    C --> D{Identity verified?}
    D -- No --> E[401 or 503]
    D -- Yes --> F[Sign Zendesk JWT with separate key]
    F --> G[Web Widget loginUser callback]
```

`sub` becomes `external_id`. The endpoint ignores the request body and only claims a verified email when the website supplies `email_verified: true`. Anonymous users can use the widget without calling this authenticated endpoint if Zendesk permits it.

## 7. Knowledge publication

```mermaid
flowchart TD
    A[Private brand archive] --> B[Validate products and manual mapping]
    B --> C{Validation passes?}
    C -- No --> D[Fix package; no upload]
    C -- Yes --> E[Extract and chunk documents]
    E --> F[Voyage document embeddings]
    F --> G[Write brand-partitioned Cosmos snapshot]
    G --> H[Publish active revision]
```

Use `--validate-only` first. Ingestion is an explicit CLI action, never a web request or background startup task. The two bundled archives remain separate, and the vector dimension must match the embedding model output.

## 8. Five-minute polling and two-hour customer sessions

```mermaid
flowchart TD
    A[Every five minutes] --> B[Export tickets updated in last five hours]
    B --> C[Fetch each ticket conversation]
    C --> D[Split at two-hour customer gaps]
    D --> E{Session due and not completed?}
    E -- No --> A
    E -- Yes --> F{Human handled it?}
    F -- Yes --> G[Mark escalated]
    F -- No --> H[Score with chat through target session]
    G --> I[Upsert Zendesk custom-object result]
    H --> I
    I --> J[(SQL Server completed-session ID)]
```

A customer return before two hours extends the current session. A return after two hours creates another session, even in the same ticket. The evaluator sees the full earlier conversation through the target session, never future outcomes. A unique custom-object external ID and the SQL Server ledger prevent repeated LLM scoring. Silence alone is not considered satisfaction. Only tickets updated in the previous five hours enter a poll.

## 9. Report and failure recovery

```mermaid
flowchart TD
    A[Private dashboard] --> B{Report bearer key valid?}
    B -- No --> C[401 or 503]
    B -- Yes --> D[Read evaluated custom object records]
    D --> E[Deduplicate ticket-session records]
    E --> F[Return satisfaction breakdown]
```

```mermaid
flowchart TD
    A[Inbox job] --> B{Processing successful?}
    B -- Yes --> C[Mark done]
    B -- No --> D{Message POST delivery uncertain?}
    D -- Yes --> E[Quarantine for manual check]
    D -- No --> F{Five attempts reached?}
    F -- Yes --> G[Mark failed for review]
    F -- No --> H[Backoff and retry]
```

A network failure after Sunshine received a message cannot safely be retried as if it were definitely unsent. The `delivery_uncertain` status prevents an automatic duplicate while this process remains alive. See `OPERATIONS.md` for local queue diagnostics and recovery guidance.
