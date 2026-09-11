import type { Preview } from '@storybook/react-vite';
import { useStore } from '../src/store';
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
    return () => useStore.setState(useStore.getInitialState(), true);
  },
};

export default preview;
