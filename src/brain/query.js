import Anthropic from '@anthropic-ai/sdk';
import { readSchema, readWikiPages } from './files.js';

const client = new Anthropic();

export async function queryDomain(domain, question) {
  const schema = await readSchema(domain);
  const pages = await readWikiPages(domain);

  if (pages.length === 0) {
    return {
      answer: "This domain's wiki is empty. Ingest some sources first.",
      citations: [],
    };
  }

  const wikiContext = pages
    .map(p => `--- FILE: ${p.path} ---\n${p.content}`)
    .join('\n\n');

  const userPrompt = `The user has a question about the "${domain}" domain.

Wiki contents (${pages.length} pages):
${wikiContext.slice(0, 90000)}

---
Question: ${question}

Instructions:
- Answer using ONLY the information in the wiki above.
- If the answer isn't in the wiki, say so honestly.
- Cite specific pages inline using [source: path/to/page.md] format.
- Synthesize across pages rather than quoting large blocks.
- End your response with a "## Sources" section listing every page you cited.`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: schema,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const answer = message.content[0].text;

  // Extract cited pages from [source: path] patterns
  const citations = [...answer.matchAll(/\[source:\s*([^\]]+)\]/g)].map(
    m => m[1].trim()
  );
  const uniqueCitations = [...new Set(citations)];

  return { answer, citations: uniqueCitations };
}
