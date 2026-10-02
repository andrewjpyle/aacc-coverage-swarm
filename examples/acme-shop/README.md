# Acme Shop demo (fictional, sample code)

Everything here is made up for the aacc-coverage-swarm demo: a shop that does not exist, two small
Python modules (`pricing.py`, `inventory.py`) and one weak test each. The baseline is 49% line
coverage, 2 tests.

One bug is **planted on purpose**: `unit_price` documents "orders of 10 or more units get the bulk
discount" but checks `quantity > BULK_THRESHOLD`, so a 10-unit order pays full price. The swarm was
not told about it.

`coverage-swarms/acme-shop_2026-10-01.md` is the **unedited** report from a real run of
`coverage_swarm_workflow.js` on 2026-10-01 (6 agents, none failed), and
`coverage-swarms/acme-shop_2026-10-01.result.json` is the full object the workflow returned. The
README's graphics are rendered from them.

What the run did, checked by hand afterwards against the two branches it left:

- Both modules went from about 50% to 100%, re-measured by the gate after its removals.
- It found the planted bug, fixed `>` to `>=`, and added a test that fails on the original code.
- The gate deleted one test as vacuous (`test_needs_reorder_empty_inventory`: it survived every
  mutation of `needs_reorder`), in a separate commit.
- On `inventory`, 3 of 23 mutations survived. The report says so rather than calling it clean.

## Reproduce it

```bash
cp -R examples/acme-shop /tmp/acme-shop
cd /tmp/acme-shop && git init -q && git add -A && git commit -qm "acme-shop sample"
```

Then, in Claude Code from `/tmp/acme-shop`:

```
Workflow({
  scriptPath: "<path to this repo>/coverage_swarm_workflow.js",
  args: {
    repo_path: "/tmp/acme-shop",
    test_cmd: "uv run --no-project --with pytest --with pytest-cov pytest --cov=acme_shop --cov-report=json --cov-report=term-missing",
    max_modules: 2,
    max_rounds: 2
  }
})
```

The module branches land in `/tmp/acme-shop.coverage-swarm/`. Model output varies run to run, so
your test names and counts will differ.
