import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";
import { formatDuration } from "../format.ts";

/** Minimal mdast shape the citation plugin touches; the full types are not a dependency. */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, string> };
}

const MARKER = /\[\[(seg|unresolved|web):([^\]\s]+)\]\]/g;

/**
 * Turns `[[seg:<id>]]`, `[[web:<id>]]` and `[[unresolved:<alias>]]` inside text into `cite` nodes before
 * rendering, so markers become app-owned elements rather than link syntax.
 * Code spans and blocks keep their text. Raw HTML becomes literal text: it is shown
 * escaped, never parsed.
 */
export function remarkCitations() {
  return (tree: MdNode): void => {
    walk(tree);
  };
}

function walk(node: MdNode): void {
  if (node.children === undefined || node.type === "code" || node.type === "inlineCode") {
    return;
  }
  const next: MdNode[] = [];
  for (const original of node.children) {
    const child: MdNode = original.type === "html" ? { type: "text", value: original.value ?? "" } : original;
    if (child.type === "text" && typeof child.value === "string" && child.value.includes("[[")) {
      next.push(...splitText(child.value));
    } else if (child.type === "text") {
      next.push(child);
    } else {
      walk(child);
      next.push(child);
    }
  }
  node.children = next;
}

function splitText(text: string): MdNode[] {
  const nodes: MdNode[] = [];
  let last = 0;
  for (const match of text.matchAll(MARKER)) {
    const index = match.index;
    if (index > last) {
      nodes.push({ type: "text", value: text.slice(last, index) });
    }
    const [, kind, value] = match as unknown as [string, "seg" | "unresolved" | "web", string];
    const properties = kind === "seg" ? { dataSegment: value } : kind === "web" ? { dataWeb: value } : { dataUnresolved: value };
    nodes.push({ type: "citation", children: [], data: { hName: "cite", hProperties: properties } });
    last = index + match[0].length;
  }
  if (last < text.length) {
    nodes.push({ type: "text", value: text.slice(last) });
  }
  return nodes;
}

/**
 * Invariant: text from platforms, AI and users is untrusted and renders only through this
 * allowlist sanitizer: no raw HTML reaches the DOM (it is turned into
 * text first, and rehype-sanitize drops anything outside this schema); link schemes are
 * limited to https / http / mailto; citations are the only extra element.
 */
export const SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "cite"],
  attributes: {
    ...defaultSchema.attributes,
    cite: ["dataSegment", "dataWeb", "dataUnresolved"],
  },
  protocols: { ...defaultSchema.protocols, href: ["https", "http", "mailto"] },
};

export interface RichTextProps {
  source: string;
  /** Start time of a cited segment when known, for the timestamp label. */
  timeOf?: (segmentId: string) => number | undefined;
  onCitation?: (segmentId: string) => void;
  /**
   * The web source a `[[web:<id>]]` marker names, looked up only among the sources of the
   * message being rendered; unknown ids show as an unresolved citation.
   */
  webSourceOf?: (sourceId: string) => { index: number; url: string; title: string } | undefined;
}

/** Source links open only for web addresses; anything else is shown as unresolved. */
const WEB_URL = /^https?:\/\//i;

function Unresolved() {
  const { t } = useTranslation();
  return (
    <span className="mx-0.5 rounded bg-sunken px-1 text-xs text-muted not-italic" data-citation="unresolved">
      {t("contentView.citation.unresolved")}
    </span>
  );
}

/** Markdown from platforms, AI or users, rendered through the sanitizer with clickable citations. */
export function RichText(props: RichTextProps) {
  const { t } = useTranslation();
  const components: Components = {
    a: ({ node: _node, ...rest }) => <a {...rest} target="_blank" rel="noopener noreferrer" className="text-accent underline" />,
    cite: ({ node: _node, ...rest }) => {
      const attributes = rest as Record<string, unknown>;
      const segmentId = attributes["data-segment"];
      const webId = attributes["data-web"];
      if (typeof webId === "string") {
        const source = props.webSourceOf?.(webId);
        if (source === undefined || !WEB_URL.test(source.url)) return <Unresolved />;
        // The href comes from the message's own source list, not from the markdown, so the
        // scheme is checked here rather than by the sanitizer.
        return (
          <sup className="mx-0.5 not-italic">
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              title={source.title}
              className="text-xs text-accent hover:underline"
              data-web-citation={webId}
            >
              [{source.index}]
            </a>
          </sup>
        );
      }
      if (typeof segmentId !== "string") {
        return <Unresolved />;
      }
      const time = props.timeOf?.(segmentId);
      return (
        <button
          type="button"
          className="mx-0.5 rounded bg-accent-soft px-1 font-mono text-xs text-accent not-italic hover:underline"
          data-citation={segmentId}
          onClick={() => props.onCitation?.(segmentId)}
        >
          {time === undefined ? t("contentView.citation.jump") : formatDuration(time)}
        </button>
      );
    },
  };
  return (
    <div className="rich-text text-sm leading-7 [&_h1]:mt-4 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-medium [&_li]:ml-5 [&_ol]:list-decimal [&_p]:my-2 [&_ul]:list-disc">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkCitations]} rehypePlugins={[[rehypeSanitize, SANITIZE_SCHEMA]]} components={components}>
        {props.source}
      </ReactMarkdown>
    </div>
  );
}
