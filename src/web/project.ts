import project from "../../project.json";

export interface ProjectInfo {
  startup: { name: string; domain: string };
  title: string;
  problem: string;
  colors: { primary: string; accent: string; background: string; text: string };
  examples_title?: string;
}

export const PROJECT = project as ProjectInfo;

/** The non-affiliation line every Project carries (AD-4). The company comes from project.json. */
export function footerText(p: ProjectInfo = PROJECT): string {
  return `independent demo by Luis Escobar, not affiliated with ${p.startup.name}`;
}
