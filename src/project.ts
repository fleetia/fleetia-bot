export type Project = {
  id: string;
  repository: string;
  domain: string;
  apiUrl: string;
  outputDirectory: string;
  validationScripts: string[];
  buildScript: string;
  additionalBuildScripts: string[];
  publicBuildEnvironment: Record<string, string>;
  ownerId: number;
};

export const project: Project = {
  id: 'kbo-knit',
  repository: 'fleetia/kbo-knit',
  domain: 'kbo-knit.star-light.space',
  apiUrl: 'https://iserlohn-test.star-light.space',
  outputDirectory: 'dist',
  validationScripts: ['lint', 'test'],
  buildScript: 'build',
  additionalBuildScripts: ['build-storybook'],
  publicBuildEnvironment: { VITE_API_BASE_URL: 'https://iserlohn-test.star-light.space' },
  ownerId: 46233501,
};
