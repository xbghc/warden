import { Children, isValidElement, memo, useEffect, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { IconButton } from './components/ui/icon-button';
import { parseFileReference } from '@warden/shared';

export function CopyText({ text, label = 'Copy Message' }: { text: string; label?: string }) {
  const [result, setResult] = useState<'copied' | 'failed'>();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <span className="acp-copy">
      <IconButton
        label={result === 'copied' ? 'Copied' : result === 'failed' ? 'Copy Failed' : label}
        onClick={async () => {
          clearTimeout(timer.current);
          try {
            await navigator.clipboard.writeText(text);
            setResult('copied');
          } catch {
            setResult('failed');
          }
          timer.current = setTimeout(() => setResult(undefined), 1800);
        }}
      >
        {result === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </IconButton>
      <span role="status" className="sr-only">
        {result === 'copied' ? 'Copied to clipboard.' : result === 'failed' ? 'Unable to copy. Select the text to copy it.' : ''}
      </span>
    </span>
  );
}

function CodeBlock({ children }: ComponentProps<'pre'>) {
  const child = Children.toArray(children)[0];
  const code = isValidElement<ComponentProps<'code'>>(child) ? child : undefined;
  const text = String(code?.props.children ?? '').replace(/\n$/, '');
  const language = code?.props.className?.replace(/^language-/, '') ?? 'Code';
  return (
    <div className="acp-code-block">
      <div className="acp-code-toolbar">
        <span>{language}</span>
        <CopyText text={text} label="Copy Code" />
      </div>
      <pre tabIndex={0}>{children}</pre>
    </div>
  );
}

export const ChatMarkdown = memo(function ChatMarkdown({ text, openFile }: { text: string; openFile?(reference: string): void }) {
  return (
    <div className="acp-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url, key) => (key === 'href' && (/^https?:\/\//i.test(url) || (openFile && parseFileReference(url))) ? url : '')}
        components={{
          pre: CodeBlock,
          a: ({ href, children }) =>
            href && /^https?:\/\//i.test(href) ? (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            ) : href && openFile && parseFileReference(href) ? (
              <button className="acp-file-link" type="button" title={`Open task file: ${href}`} onClick={() => openFile(href)}>
                {children}
              </button>
            ) : (
              <span>{children}</span>
            ),
          // Replies cannot load remote images or invoke VS Code commands.
          img: ({ alt }) => <span className="muted">{alt ? `[Image: ${alt}]` : '[Image]'}</span>,
          table: ({ children }) => (
            <div className="acp-table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
});
