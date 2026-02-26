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
docker-compose up --build

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

### Components

| Component             | Tech                 | Purpose                                                       |
| --------------------- | -------------------- | ------------------------------------------------------------- |
| **Ingestion Service** | Node.js + TypeScript | Parses CSV/PDF/PPT, chunks text, populates ChromaDB and Neo4j |
| **API Service**       | Bun + Hono           | REST API + chat UI, orchestrates retrieval pipeline           |
| **ChromaDB**          | Vector database      | Semantic search over document chunks                          |
| **Neo4j**             | Graph database       | Structured queries over entity relationships                  |
| **Groq**              | LLM inference        | Generates natural language answers from retrieved context     |

---

## Datasets

| File               | Type             | Contents                                                              |
| ------------------ | ---------------- | --------------------------------------------------------------------- |
| `tax_data.csv`     | CSV (5,000 rows) | Tax records: taxpayer type, state, year, income, deductions, tax owed |
| `i1040gi.pdf`      | PDF              | IRS Form 1040 General Instructions                                    |
| `usc26@118-78.pdf` | PDF              | US Tax Code Title 26 excerpts                                         |
| `MIC_3e_Ch11.ppt`  | PPT              | Financial/economics textbook chapter                                  |

**Downloading data:** Place all four files in the `data/` directory. Download them from the [provided Google Drive folder](https://drive.google.com/drive/u/1/folders/1SQv45d8I_XnIUOghkTSZ3OkUk0UzNSAO). All four files are required for full evaluation coverage (including the "What does the IRS Form 1040 cover?" question).

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

### 4. Why Hybrid?

| Approach    | Strengths                                                         | Weaknesses                                                      |
| ----------- | ----------------------------------------------------------------- | --------------------------------------------------------------- |
| Vector only | Great for fuzzy/semantic queries ("tell me about tax deductions") | Poor at precise aggregations ("average income for corps in TX") |
| Graph only  | Exact aggregations, relationship traversal                        | Can't search unstructured text (PDFs, presentations)            |
| **Hybrid**  | Combines both — semantic matching + structured queries            | Slightly more complex, worth it for accuracy                    |

---

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

---

## Environment Variables

```
GROQ_API_KEY=your-groq-api-key      # Required — get free at https://console.groq.com
NEO4J_URI=bolt://neo4j:7687         # Set automatically in Docker
NEO4J_USER=neo4j
NEO4J_PASSWORD=password123
CHROMA_URL=http://chromadb:8000
```

---

## Running Tests

Tests require the full stack to be running. The API service waits for ingestion to complete before starting, so no manual waiting is needed:

```bash
# Start the stack (API starts only after ingestion completes)
docker-compose up --build -d

# Optionally watch ingestion progress
docker-compose logs -f ingestion

# Run tests
cd tests && bun test
```

The test suite includes:

- **API health checks** — verifies the server responds correctly
- **Evaluation questions** — sends 10 tax-related questions and checks that responses contain expected keywords

---

## Services

| Service       | URL                          | Description                             |
| ------------- | ---------------------------- | --------------------------------------- |
| Chat UI       | http://localhost:3000        | Browser-based chat interface            |
| Health check  | http://localhost:3000/health | API readiness endpoint                  |
| Neo4j Browser | http://localhost:7474        | Graph visualization (neo4j/password123) |
| ChromaDB      | http://localhost:8000        | Vector store API                        |

---

## Project Structure

```
├── data/                          # Datasets (CSV, PDF, PPT)
├── services/
│   ├── ingestion/                 # Data processing pipeline
│   │   ├── src/
│   │   │   ├── parsers/           # CSV, PDF, PPT parsers
│   │   │   ├── chunker.ts         # Text chunking with overlap
│   │   │   ├── vectorStore.ts     # ChromaDB operations
│   │   │   ├── graphStore.ts      # Neo4j graph construction
│   │   │   └── index.ts           # Pipeline orchestrator
│   │   └── Dockerfile
│   └── api/                       # Chat API server
│       ├── src/
│       │   ├── retrieval/         # Vector + graph retrieval
│       │   ├── routes/            # HTTP route handlers
│       │   ├── pipeline.ts        # RAG orchestration
│       │   ├── public/            # Chat UI
│       │   └── index.ts           # Server entry point
│       └── Dockerfile
├── tests/                         # API + evaluation tests
├── docker-compose.yml
└── README.md
```
