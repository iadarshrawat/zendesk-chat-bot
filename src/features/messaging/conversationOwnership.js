const CUSTOMER_AUTHOR_TYPES = ["user", "end_user"];
const AGENT_WORKSPACE_NAME = /^(zd-)?agentWorkspace$/i;

export function shouldSkipMessage(author) {
  const isCustomer = CUSTOMER_AUTHOR_TYPES.includes(author?.type);
  const wasGeneratedByAi = author?.subtypes?.includes("AI") === true;
  return !isCustomer || wasGeneratedByAi;
}

export function isAgentActive(integration) {
  const integrationId = typeof integration === "string" ? integration : integration?.id;
  const integrationName = typeof integration === "string" ? integration : integration?.name;
  const configuredAgentId = process.env.SUNSHINE_AGENT_WORKSPACE_INTEGRATION_ID;

  if (configuredAgentId && integrationId === configuredAgentId) {
    return true;
  }

  return AGENT_WORKSPACE_NAME.test(integrationName || "");
}
