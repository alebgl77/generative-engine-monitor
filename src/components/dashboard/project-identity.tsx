"use client";

import * as React from "react";

interface ProjectIdentity {
  projectName: string;
}

const ProjectIdentityContext = React.createContext<ProjectIdentity | null>(null);

export function ProjectIdentityProvider({
  projectName,
  children,
}: ProjectIdentity & { children: React.ReactNode }) {
  return (
    <ProjectIdentityContext.Provider value={{ projectName }}>
      {children}
    </ProjectIdentityContext.Provider>
  );
}

export function useProjectIdentity(): ProjectIdentity {
  const value = React.useContext(ProjectIdentityContext);
  if (!value) {
    throw new Error("ProjectIdentityProvider is missing from the project layout");
  }
  return value;
}
