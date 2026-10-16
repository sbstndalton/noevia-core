# rag-eval: chunker comparison (noevia#1866)

Compares document chunkers on **synthetic** paged documents (invented towns, `[Page N]` text exactly as
`documents.cjs` `assemble()` writes it). Gold is a **span**: a retrieved chunk is a hit when it holds the whole
gold answer sentence, so arms with different chunk sizes are comparable. Extends the #1665 reranker harness,
which only scored pre-cut passages.

| Arm | Chunker |
|---|---|
| A | current `rag.chunkText` (1200 chars, 150 overlap, per page); a test keeps it identical to `server/rag.cjs` |
| B | sentence-snapped, same size and per-page handling |
| C / D / E | sentence-aligned windows of about 256 / 512 / 768 tokens (chars/4), across page breaks, start page kept as `[Page N]` |
| F | `--fbase` arm (C, D or E) with the section heading prefixed |

Each arm is scored with cosine only (top 12 at >= 0.3, keep 6) and with gte rerank of the 12 (keep 6; passages
capped at 4000 chars). `rerankWithDeadline` scores what production returns when a rerank misses the 3 s deadline.

```
node chunk-eval.cjs gen <dir> --docs=3 --queries=5          # smoke set (seed 1866)
node chunk-eval.cjs chunk <dir>/dataset.json <out>          # offline chunk stats + gold coverage
W=<workdir> SRC=<dir with chunk-eval.cjs, run.sh, dataset.json> bash run.sh smoke|full|clean   # DaServer
```

`run.sh` gates on llama idle, GTT <= 1 GiB, MemAvailable >= 8 GiB, no autotune, no document work. It uses
throwaway `rr3-*` containers (`--rm`, 2 CPU / 2 GB at most), and embeds through the live embed service read-only,
one request at a time with a 1 s gap, pausing while chat is active. Rerank runs in its own offline TEI container, not
`cowork-rerank-1`. There are no pulls and no prune, and every step has a deadline. Full run: 20 docs, 360 queries,
off-hours, scheduled by the coordinator.
