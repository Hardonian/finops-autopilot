export interface FinOpsHooks {
  module_id: string;
  capability: string;
  tenant_id: string;
  project_id: string;
  cost_context: {
    cost_center: string;
    tags: string[];
  };
}

export function buildFinOpsHooks(params: {
  tenantId: string;
  projectId: string;
  capability: string;
}): FinOpsHooks {
  return {
    module_id: 'finops',
    capability: params.capability,
    tenant_id: params.tenantId,
    project_id: params.projectId,
    cost_context: {
      cost_center: `${params.tenantId}:${params.projectId}`,
      tags: ['finops', params.capability],
    },
  };
}
