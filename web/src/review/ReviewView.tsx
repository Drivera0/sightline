import { EmptyState, Panel } from "../shell/components";

/** Lane D, hours 18-26: ranked crops, P/N/U keys, frame view, progress (LANE_D_PIPELINE section 9.2). */
export function ReviewView() {
  return (
    <Panel className="h-full">
      <EmptyState title="Review queue">The ranked crops arrive in hours 18–26.</EmptyState>
    </Panel>
  );
}
