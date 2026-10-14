# Ontology Mapping Studio

A static, client-side web app that maps CSV columns to the concepts of **any OWL ontology you load** (.ttl / .rdf / .owl — Turtle via N3.js, RDF/XML via the browser's XML parser; classes, data properties, restrictions) and exports the result as **YAML** (your `schema_version 0.1` format), **R2RML** (for Morph-KGC / Ontop), or **JSON**.

Pipeline per column: 🔤 lexical match on labels/synonyms → 🧠 optional semantic match (all-MiniLM-L6-v2 embeddings, in-browser — applied to column names AND cell values, for key-value data models) → 🧪 value profiling (Excel serial dates, booleans, identifiers) → 🕸 OWL validation (domain/range, type checks, restriction templates) → ✅ your confirmation.

## Files

| File | Purpose |
|---|---|
| `index.html` | the page |
| `styles.css` | styling |
| `app.js` | parser, matcher, reasoner, exports |
| `sample_ontology.ttl` | bundled demo ontology (auto-loaded if present; delete to disable) |
| `sample_data.csv` | synthetic demo data (safe to publish) |

## Deploy on GitHub Pages

1. Create a repository and copy all files of this folder into its root (keep names).
2. Repo → Settings → Pages → Source: *Deploy from a branch* → branch `main`, folder `/ (root)`.
3. Open `https://<user>.github.io/<repo>/`.

`index.html` loads `n3.min.js` from cdn.jsdelivr.net (Turtle parsing); if your proxy blocks it, download that one file into the repo and change the script tag to `src="n3.min.js"`. Any static hosting (or a local `python -m http.server`) works too. Opening `index.html` directly from disk (`file://`) will not load the JSON files — use an HTTP server.

## Semantic matching with your all-MiniLM-L6-v2

The model runs **inside the browser** via transformers.js (ONNX). The page cannot read `C:\models\...` directly. Two options:

- **Default (no setup):** click *Enable semantic matching* — transformers.js downloads the ONNX build `Xenova/all-MiniLM-L6-v2` from the Hugging Face CDN once (~23 MB quantized) and caches it in the browser.
- **Self-hosted (works behind strict proxies):** your local folder most likely contains PyTorch weights (`pytorch_model.bin` / `model.safetensors`), which browsers cannot run. Download the ONNX variant from `huggingface.co/Xenova/all-MiniLM-L6-v2` and copy into your repo:
  ```
  models/all-MiniLM-L6-v2/config.json
  models/all-MiniLM-L6-v2/tokenizer.json
  models/all-MiniLM-L6-v2/tokenizer_config.json
  models/all-MiniLM-L6-v2/onnx/model_quantized.onnx
  ```
  then set `SELF_HOSTED_MODEL = true` at the top of `app.js`. All files are under GitHub's 100 MB limit.

## Using it

1. Load your ontology (🦉 button; .ttl/.rdf/.owl — parsed locally). The bundled `sample_ontology.ttl` auto-loads if present. Clinical-demo templates (milestone dates, planned/actual) activate only when the loaded ontology contains those concepts (matched by URI); any other ontology gets the generic pipeline.
2. Load your CSV via the file button (it is parsed locally and **never uploaded**).
3. Optionally enable semantic matching (also matches cell values to ontology individuals — e.g. a `Milestone` column containing "siv compl." proposes the restriction *Site Milestone Name = SIV*).
4. Set the default key fields (🔑 box, prefilled with a guess) — override per mapping in its editor.
5. *Propose mappings* → review the cards: confidence, source badges, restriction chips, ontology-gap suggestions (e.g. a missing `FPFV` Site Milestone Name individual).
6. Confirm/edit/ignore; decisions persist in the browser (localStorage).
7. Export YAML / R2RML / JSON — download or copy, commit wherever you keep mappings.

## Next step: actually producing triples / querying

- **Materialize RDF:** `pip install morph-kgc`, point it at the exported R2RML + your CSV (or the SQLite DB you build from the CSVs), load the output into `rdflib`/GraphDB and query with SPARQL.
- **Virtual SPARQL endpoint:** Ontop over a JDBC database using the same R2RML (Ontop adds OWL 2 QL reasoning during query rewriting).

## ⚠️ Data note

GitHub Pages sites and public repos are world-readable. Publish only the app and synthetic data; keep real tracker CSVs and any exported mappings containing internal information in private/internal storage, per your data-handling policies.
