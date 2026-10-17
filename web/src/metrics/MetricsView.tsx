import { EmptyState, Panel } from "../shell/components";

/** Mount point for lane A: detector vs human, ablations, ranking, search simulation. Replace this file. */
export function MetricsView() {
  return (
    <Panel className="h-full">
      <EmptyState title="Metrics">Lane A builds the metrics screen here.</EmptyState>
    </Panel>
  );
}
