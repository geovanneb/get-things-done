import matter from 'gray-matter';

const options = {
  engines: {
    javascript: () => { throw new Error('Invalid frontmatter: executable languages are not supported'); },
  },
};

/** Explicit options disable gray-matter's unbounded content cache and its executable JS engine (including js aliases). */
export function parseMarkdown(raw: string) {
  return matter(raw, options);
}

export function stringifyMarkdown(content: string, data: Record<string, unknown>): string {
  return matter.stringify(content, data, options);
}
