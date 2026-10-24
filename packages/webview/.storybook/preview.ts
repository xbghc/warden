import type { Preview } from '@storybook/react-vite';
import '../src/styles.css';

const preview: Preview = {
  tags: ['autodocs'],
  parameters: {
    layout: 'padded',
    docs: { story: { inline: false, height: '640px' } },
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
  },
};

export default preview;
