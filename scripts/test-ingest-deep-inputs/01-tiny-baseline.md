# A Short Note on Vector Databases

By Dr. Tali Rezun · April 2026

Vector databases like Pinecone, Weaviate, and Chroma are the backbone of
retrieval-augmented generation (RAG) systems. They store text embeddings —
high-dimensional numerical representations of meaning — and let an
application query for "the most similar passage to this question" in
milliseconds. Without a vector database, every RAG query would have to
scan the entire corpus from scratch.

The most common embedding model in 2024–2026 is OpenAI's text-embedding-3
family, which produces 1536- or 3072-dimensional vectors. Google's
text-embedding-004 and Anthropic's Voyage embeddings compete on quality
and price; for self-hosted use, Sentence-BERT and BGE-large remain the
go-to open weights.

Two core concepts make vector search tractable at scale: approximate
nearest neighbour (ANN) algorithms, and quantization. ANN gives up
exactness for a 100× speedup — HNSW and IVF are the dominant index types.
Quantization compresses vectors from 32-bit floats to 8-bit integers (or
binary, in extreme cases) for an additional 4× to 32× memory reduction
with minimal recall loss.

The case AGAINST vector databases is that frontier models now fit a
million tokens in context — for many use cases (small corpora, one-off
research projects) you can simply feed the whole document set to the
model and skip embedding altogether. See "Why I Ditched RAG" by Dr.
Rezun for the long-form argument.

Tags: vector-database, rag, embeddings, ann

---

This is a baseline test source. Expected entities: Pinecone, Weaviate,
Chroma, OpenAI, Google, Anthropic, Dr. Tali Rezun.
Expected concepts: vector-databases, retrieval-augmented-generation,
embeddings, approximate-nearest-neighbour, quantization.
