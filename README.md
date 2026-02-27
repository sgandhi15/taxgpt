# TaxGPT — Financial Data RAG Chatbot

A retrieval-augmented generation (RAG) chatbot that answers questions about financial/tax data using a hybrid **vector + graph** approach. Built with ChromaDB for semantic search, Neo4j for structured relationship queries, and Groq LLM for natural language generation.

**Author:** Sarthak Gandhi

---

## Quick Start

```bash
# 1. Clone and set up environment
cp .env.example .env
# Edit .env and add your GROQ_API_KEY (free at https://console.groq.com)

# 2. Start everything
docker compose up --build

# 3. Open http://localhost:3000 in your browser
```

The ingestion service runs automatically on first startup, processing all datasets into the vector and graph stores. Subsequent startups skip ingestion if data is already loaded.

---

## Architecture

```
┌────────────┐     ┌───────────┐     ┌──────────┐
│  Chat UI   │────▶│  API      │────▶│  Groq    │
│  (HTML/JS) │◀────│  (Hono)   │◀────│  LLM     │
└────────────┘     └─────┬─────┘     └──────────┘
                         │
                ┌────────┴────────┐
                ▼                 ▼
          ┌──────────┐     ┌──────────┐
          │ ChromaDB │     │  Neo4j   │
          │ (Vector) │     │ (Graph)  │
          └──────────┘     └──────────┘
                ▲                 ▲
                └────────┬────────┘
                         │
                   ┌───────────┐
                   │ Ingestion │
                   │ Service   │
                   └─────┬─────┘
                         │
                ┌────────┴────────┐
                │   Data Files    │
                │ CSV / PDF / PPT │
                └─────────────────┘
```

---

## How It Works

### 1. Ingestion Pipeline

The ingestion service processes each data source:

- **CSV**: Each row becomes a text chunk describing the tax record. Summary chunks are generated per taxpayer type, state, and year. The CSV data is also used to build the Neo4j knowledge graph.
- **PDF**: Text is extracted with `pdf-parse` and split into overlapping 500-token chunks for dense retrieval.
- **PPT**: Text is extracted with `catppt` (binary .ppt) and chunked similarly.

All chunks are stored in ChromaDB with source metadata. ChromaDB generates embeddings using its built-in `all-MiniLM-L6-v2` model.

### 2. Knowledge Graph (Neo4j)

The CSV data is modeled as a graph with aggregate statistics:

**Nodes:**

- `TaxpayerType` — Individual, Corporation, Partnership, Trust, Non-Profit
- `State` — US state abbreviations (CA, TX, NY, etc.)
- `TaxYear` — 2019–2023
- `IncomeSource` — Salary, Investment, Capital Gains, Rental, Business Income, Royalties
- `DeductionType` — Charitable Contributions, Mortgage Interest, Education, Medical, Business Expenses

**Relationships (with aggregate properties):**

- `OPERATES_IN` — TaxpayerType → State (count, avg/total income, avg/total tax)
- `ACTIVE_IN_YEAR` — TaxpayerType → TaxYear
- `EARNED_BY` — IncomeSource → TaxpayerType
- `CLAIMED_BY` — DeductionType → TaxpayerType
- `HAS_RECORDS_IN` — State → TaxYear

This allows the graph to directly answer questions like "What is the average tax owed by corporations in California?" without scanning all 5,000 records.

### 3. Hybrid Retrieval

When a user asks a question, both retrieval systems run in parallel:

1. **Vector search** (ChromaDB): Finds the top-5 semantically similar document chunks.
2. **Graph query** (Neo4j): Extracts entities (taxpayer types, states, years, income sources, deduction types) from the query and runs targeted Cypher queries to fetch aggregate statistics.

Both results are merged into a context block and sent to the LLM for answer generation.

## Design Decisions

### Why ChromaDB?

- Lightweight vector database that runs in a single Docker container
- Built-in embedding function (`all-MiniLM-L6-v2`) removes the need for a separate embedding service
- Simple API for both ingestion and querying

### Why Neo4j?

- Mature graph database with expressive Cypher query language
- Stores pre-computed aggregates on relationships, making analytical queries fast
- Built-in browser UI for visualizing the knowledge graph (http://localhost:7474)

### Why Groq?

- Very fast inference via their custom LPU hardware
- Free tier available for development and demos
- Supports Llama 3.3 70B which handles financial reasoning well

### Why Bun for the API?

- Fast startup and runtime, good for a demo
- Native TypeScript support without a build step
- Compatible with Hono framework for a clean API

### Embedding Consistency

ChromaDB's server-side embedding function is used for both ingestion and queries (`queryTexts` API). This guarantees the same model encodes both documents and queries, avoiding vector space mismatches.
