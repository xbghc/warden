import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import type { Preview } from '@storybook/react-vite';
import { useStore } from '../src/store';
import { useWorkflow } from '../src/workflow-store';
import { useWorkbench } from '../src/workbench-store';
import { useWorkbenchData } from '../src/workbench-data';
import '../src/styles.css';

const preview: Preview = {
  tags: ['autodocs'],
  parameters: {
    layout: 'padded',
    // Store-backed stories need their own iframe, including on the Docs page.
    docs: { story: { inline: false, height: '420px' } },
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
  },
  beforeEach() {
    useStore.setState(useStore.getInitialState(), true);
    useWorkbench.setState(useWorkbench.getInitialState(), true);
    useWorkbenchData.setState(useWorkbenchData.getInitialState(), true);
    useWorkflow.setState(useWorkflow.getInitialState(), true);
    return () => {
      useStore.setState(useStore.getInitialState(), true);
      useWorkbench.setState(useWorkbench.getInitialState(), true);
      useWorkbenchData.setState(useWorkbenchData.getInitialState(), true);
      useWorkflow.setState(useWorkflow.getInitialState(), true);
    };
  },
};

export default preview;
