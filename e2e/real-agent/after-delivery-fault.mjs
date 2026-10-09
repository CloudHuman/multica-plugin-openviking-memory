import { readFileSync, writeFileSync } from 'node:fs';

/** Explicit E2E-only fault after the server confirms a persisted final comment. */
export default async function DeliveryFault() {
  const path = process.env.OVMEM_E2E_DELIVERY_FAULT;
  // Multica strips inherited MULTICA_* variables from every agent backend.
  // The explicitly authorized parent runner supplies this test-only gate.
  if (process.env.OVMEM_E2E_DELIVERY_AUTHORIZED !== '1' || !path) return {};
  let receipt;
  return {
    'tool.execute.after': async (input, output) => {
      let plan;
      try { plan = JSON.parse(readFileSync(path, 'utf8')); } catch { return; }
      if (!plan.issueId || plan.injected) return;
      const access = JSON.parse(readFileSync(plan.accessFile, 'utf8'));
      const response = await fetch(`${plan.base}/api/issues/${plan.issueId}/comments`, { headers: { Authorization: `Bearer ${access.token}`, 'X-Workspace-ID': access.workspaceId } });
      if (!response.ok) return;
      const data = await response.json();
      const comments = Array.isArray(data) ? data : data.comments ?? [];
      const final = comments.find(c => c.author_type === 'agent' && c.source_task_id && /"budget_yuan"/.test(c.content) && /"source"/.test(c.content));
      const acknowledged = final && (output.output?.includes(final.id)
        || (input.tool === 'bash' && output.output?.trim() === `Comment added to issue ${plan.issueId}.`));
      if (acknowledged) receipt = { taskId: final.source_task_id, commentId: final.id };
    },
    config: async config => {
      const options = config.provider.openrouter.options;
      const original = options.fetch ?? globalThis.fetch;
      options.fetch = async (input, init) => {
        if (receipt) {
          const plan = JSON.parse(readFileSync(path, 'utf8'));
          let model;
          try { model = JSON.parse(init?.body).model; } catch { /* Only inject a known main-model request. */ }
          if (!plan.injected && model === plan.model) {
            writeFileSync(path, JSON.stringify({ ...plan, ...receipt, injected: true, source: 'controlled-e2e-fault', ts: new Date().toISOString() }), { mode: 0o600 });
            receipt = null;
            return new Response(JSON.stringify({ error: { message: 'Missing Authentication header', code: 401 } }), { status: 401, headers: { 'Content-Type': 'application/json' } });
          }
        }
        return original(input, init);
      };
    },
  };
}
