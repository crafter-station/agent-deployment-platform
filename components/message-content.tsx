import ReactMarkdown from "react-markdown";

export default function MessageContent({ content }: { content: string }) {
  return (
    <div className="message-markdown">
      <ReactMarkdown
        skipHtml
        components={{
          a: ({ href, children }) => {
            const allowed =
              href &&
              (/^https?:\/\//i.test(href) ||
                /^\/(?!\/)/.test(href) ||
                href.startsWith("#"));
            return allowed ? (
              <a
                href={href}
                target={href.startsWith("http") ? "_blank" : undefined}
                rel="noopener noreferrer nofollow"
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            );
          },
          img: ({ alt }) => <span>{alt || "Imagen"}</span>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
