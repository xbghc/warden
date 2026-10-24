import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  framework: '@storybook/react-vite',
  addons: ['@storybook/addon-docs'],
  core: { disableTelemetry: true },
  // Build isolated component examples rather than the extension entry point.
  viteFinal(config) {
    return {
      ...config,
      // Relative assets work both locally and under a GitHub Pages repository path.
      base: './',
      server: { ...config.server, proxy: {} },
      build: { ...config.build, lib: undefined, outDir: 'storybook-static' },
    };
  },
};

export default config;
