"use client";

import { useCallback, useRef, useState } from "react";

import { MembersSetup } from "@/components/project-context/members-setup";
import { WorkspaceSetup } from "@/components/project-context/workspace-setup";

type ProjectSetupPanelProps = {
  projectId: string;
  onWorkspaceConfirmationChange?: (open: boolean) => void;
};

type CoordinatedVersion = {
  projectId: string;
  version?: number;
};

export function ProjectSetupPanel({
  projectId,
  onWorkspaceConfirmationChange,
}: ProjectSetupPanelProps) {
  const [coordinatedVersion, setCoordinatedVersion] =
    useState<CoordinatedVersion>({ projectId });
  const projectVersion =
    coordinatedVersion.projectId === projectId
      ? coordinatedVersion.version
      : undefined;
  const setupRootRef = useRef<HTMLElement>(null);
  const handleVersionChange = useCallback(
    (version: number) => {
      setCoordinatedVersion((current) => ({
        projectId,
        version:
          current.projectId === projectId && current.version !== undefined
            ? Math.max(current.version, version)
            : version,
      }));
    },
    [projectId],
  );

  return (
    <section
      aria-labelledby={`project-setup-title-${projectId}`}
      className="stack project-setup"
      ref={setupRootRef}
    >
      <h2 id={`project-setup-title-${projectId}`}>项目设置</h2>
      <WorkspaceSetup
        onVersionChange={handleVersionChange}
        projectId={projectId}
        projectVersion={projectVersion}
        setupRootRef={setupRootRef}
        onConfirmationChange={onWorkspaceConfirmationChange}
      />
      <MembersSetup
        onVersionChange={handleVersionChange}
        projectId={projectId}
        projectVersion={projectVersion}
      />
    </section>
  );
}
