# A Hands-On Tour of JSON Mode, Tool Use, and Structured Output

By Dr. Tali Rezun · 2026

Frontier models in 2026 produce structured output through three different
mechanisms, and the choice between them shapes the reliability of any
agent built on top of them. This article tours each.

## Native JSON mode

Both OpenAI's `response_format: { type: "json_object" }` and Google's
`responseMimeType: "application/json"` force the model to emit valid
JSON at the token-decoder level — invalid tokens are simply masked out
during generation. The result is a guarantee that whatever comes back
will parse with `JSON.parse()` on the first try.

Anthropic notably does NOT offer this. Claude's path to structured
output is via "tool use" (described below) or via prompt + jsonrepair.

A subtle gotcha: native JSON mode doesn't guarantee SCHEMA validity. The
model can produce `{"name": "Alice", "age": "thirty"}` when you asked
for an integer age — only that the response will be syntactically valid
JSON. Layer Zod, Pydantic, or jsonschema validation on top.

## Tool use (function calling)

The tool-use mechanism — `tools: [{name: "save_user", input_schema: ...}]`
— lets you describe a function the model should call. The model's
response includes a structured `tool_use` block with the JSON arguments
constrained to your schema. This is what Anthropic recommends instead
of JSON mode, and it works on every frontier API in 2026.

Tool use is more reliable than JSON mode for complex schemas (because
the model has been trained against tens of millions of tool-use
examples) but it adds a turn of friction: you have to "execute" the
tool and feed the result back into the conversation.

## Prompt-only + repair

The third path is the brute-force one: ask the model to produce JSON in
plain text and use a library like `jsonrepair` to fix any minor
mistakes (unescaped quotes, trailing commas, stray backticks). This is
what The Curator's ingest pipeline uses for Anthropic, which lacks JSON
mode entirely.

The Curator's `parseJSON` function tries four strategies in order:
1. `JSON.parse(raw)` — fast path, works most of the time
2. Strip markdown fences (```json ... ```) and retry
3. Extract the outermost `{...}` block and retry
4. Run jsonrepair and retry

This is robust enough that even malformed responses (a quote in the
middle of a 10kb summary string, say) parse cleanly. The remaining
failure mode is responses that are TRUNCATED — and that's why v3.0.1-
beta.8 added `stop_reason: max_tokens` detection upstream of parseJSON.

## A worked example: extracting wikilinks

Suppose you want a model to produce a list of `[[wikilinks]]` from a
source document. Bad prompt:

> "Return the entities as a list of wikilinks."

The model returns: ```Alice, Bob, "Carol's lab"```. JSON-parseable? No.

Better prompt:

> Return ONLY valid JSON: `{"entities": ["alice", "bob", "carol-s-lab"]}`.
> No markdown fences, no commentary.

Even with this prompt, ~5% of responses include a stray backtick or an
unescaped quote. That's where the four-stage parseJSON dance earns its
keep.

Tags: json-mode, tool-use, structured-output, parsing

---

This source deliberately contains many JSON-stressor characters:
backticks, quoted strings inside content, embedded code blocks, and
text that looks like JSON keys/values. It tests that parseJSON and the
LLM's own output handling survive contact with content that mentions
JSON syntax.
