import { useEffect, useRef } from "react";

import { HealthReportView } from "../health/HealthReportView.js";
import { useHealth } from "../health/useHealth.js";
import type { CoreTransport } from "../transport/CoreTransport.js";

/** The Health page: the latest glycolens report from the home PC. */
export function Health({ transport }: { transport: CoreTransport | undefined }): JSX.Element {
  const health = useHealth(transport);
  const asked = useRef(false);
  // Once per visit: ask the PC for its report.json in case glycolens ran outside Noctis.
  useEffect(() => {
    if (asked.current || health.status === undefined) return;
    if (health.status.granted && health.status.nodeOnline && health.status.busy === null) {
      asked.current = true;
      void health.refresh();
    }
  }, [health.status]);
  return (
    <HealthReportView
      status={health.status}
      now={new Date()}
      error={health.error}
      onRunNow={() => void health.runNow()}
      onDecide={(id, action) => void health.decide(id, action)}
    />
  );
}
