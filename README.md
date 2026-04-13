# Semantic Constellation

A cognitive interface for exploring Igbo cosmological knowledge — part of the [Igbo Origins](../igboorigins) research initiative.

## What It Is

Semantic Constellation is not a search engine.

It is a spatial, interactive map where **meaning becomes visual proximity**. Documents that share cosmological themes cluster together in space. Explicit cultural relationships are drawn as edges between nodes. A natural-language question lights up the parts of the space most relevant to it.

The interface treats Igbo cosmological knowledge as a living graph — where myths, deities, places, and ritual narratives are not isolated entries to be retrieved, but constellations of meaning to be navigated.

## Core Concepts

### Spatial Proximity = Semantic Similarity
Documents, myths, and concepts are embedded into a high-dimensional semantic space. What appears close together, *means* close together — shared cosmological themes, overlapping deity systems, related origin stories.

### Edges = Explicit Cultural Relationships
Beyond similarity, known relationships are drawn explicitly: a deity's domain, a town's founding myth, a ritual's cosmological context. These edges encode cultural structure that pure similarity cannot capture.

### Query Illumination
A natural-language question does not return a list of results. It illuminates — casting light across the map, brightening nodes and clusters most relevant to the question, allowing the user to follow meaning spatially rather than linearly.

## Design Principles

- **Spatial over sequential** — knowledge is navigated, not scrolled
- **Relational over retrieval** — meaning emerges from connections, not isolated documents
- **Cultural fidelity** — structure respects indigenous categories, not imposed taxonomies
- **Exploratory by default** — the interface invites wandering as much as directed inquiry

## Architecture (Planned)

```
semantic_constellation/
├── embeddings/       # Document and concept vector representations
├── graph/            # Explicit relationship graph (nodes, edges, metadata)
├── interface/        # Spatial visualisation and interaction layer
├── query/            # Natural-language query processing and illumination logic
└── corpus/           # Source documents from the Igbo Origins corpus
```

## Relationship to Igbo Origins

Semantic Constellation is the cognitive interface layer built on top of the Igbo Origins research corpus. Igbo Origins collects and structures the knowledge; Semantic Constellation makes it explorable.

## Status

Early design and architecture phase. Contributions to corpus structure, graph schema, and interface design are welcome.
