import type { DisplaySettings } from '../domain/types';

export type ProjectFile = {
  version: 1;
  title: string;
  manuscriptText: string;
  currentTokenIndex: number;
  displaySettings: DisplaySettings;
  cuePoints: number[];
  asrProvider: 'manual' | 'mock';
};

export function createProjectFile(project: Omit<ProjectFile, 'version'>): ProjectFile {
  return {
    version: 1,
    ...project
  };
}
