/** Workbench availability is independent of an agent's protocol and process owner. */
export type AgentConfiguration = { status: 'missing' } | { status: 'invalid'; message: string } | { status: 'configured'; count: number };

export interface AgentIdentity {
  id: string;
  label: string;
}

export interface AgentAuthMethod {
  id: string;
  name: string;
  description?: string;
}

/** An integration reports readiness; installed tools and saved settings alone are insufficient. */
export interface AgentReadiness {
  status: 'unchecked' | 'checking' | 'authentication_required' | 'ready' | 'error';
  profile?: AgentIdentity;
  message?: string;
  authMethods?: AgentAuthMethod[];
}
